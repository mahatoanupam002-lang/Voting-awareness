/**
 * api/notify.js — Internal endpoint to send Web Push notifications to all subscribers.
 *
 * Called from GitHub Actions after a data refresh:
 *   curl -X POST https://<domain>/api/notify \
 *        -H "Authorization: Bearer $NOTIFY_SECRET" \
 *        -H "Content-Type: application/json" \
 *        -d '{"title":"Data updated","body":"New corruption case data available.","url":"/corruption"}'
 *
 * Required env vars:
 *   KV_REST_API_URL      — Vercel KV REST URL
 *   KV_REST_API_TOKEN    — Vercel KV REST token
 *   NOTIFY_SECRET        — shared secret for auth (set in Vercel + GitHub Actions secrets)
 *   VAPID_SUBJECT        — mailto: or https: VAPID subject (e.g. "mailto:bot@bengal-reader.app")
 *   VAPID_PUBLIC_KEY     — base64url-encoded uncompressed P-256 public key (65 bytes)
 *   VAPID_PRIVATE_KEY    — base64url-encoded P-256 private key (32 bytes)
 */

export const config = { runtime: 'edge' };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const NOTIFY_SECRET = process.env.NOTIFY_SECRET;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:bot@bengal-reader.app';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

// ── base64url helpers ─────────────────────────────────────────────────────────
function b64uDecode(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
function b64uEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── VAPID JWT ─────────────────────────────────────────────────────────────────
async function makeVapidJwt(audience) {
  const header = b64uEncode(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const payload = b64uEncode(new TextEncoder().encode(JSON.stringify({ aud: audience, exp, sub: VAPID_SUBJECT })));
  const unsigned = `${header}.${payload}`;

  const rawKey = b64uDecode(VAPID_PRIVATE_KEY);
  // Import as PKCS8 — must prepend the EC private key header
  const pkcs8Header = new Uint8Array([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48,
    0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
    0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(pkcs8Header.length + rawKey.length);
  pkcs8.set(pkcs8Header);
  pkcs8.set(rawKey, pkcs8Header.length);

  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64uEncode(new Uint8Array(sig))}`;
}

// ── List all subscriptions from KV ───────────────────────────────────────────
async function listSubscriptions() {
  // Scan keys matching "sub:*" using KV SCAN command
  let cursor = 0;
  const subs = [];
  do {
    const res = await fetch(`${KV_URL}/scan/${cursor}?match=sub%3A*&count=100`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!res.ok) break;
    const data = await res.json();
    cursor = data.result[0];
    const keys = data.result[1] || [];
    for (const k of keys) {
      const vRes = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      if (vRes.ok) {
        const vData = await vRes.json();
        if (vData.result) subs.push(vData.result);
      }
    }
  } while (cursor !== 0);
  return subs;
}

// ── Send one push message (RFC 8030 + RFC 8291) ───────────────────────────────
async function sendPush(sub, payload) {
  const url = sub.endpoint;
  const origin = new URL(url).origin;
  const jwt = await makeVapidJwt(origin);
  const vapidHeader = `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`;

  // Minimal unencrypted push (no body encryption — plaintext only works with some services;
  // for production use aesgcm/aes128gcm encryption)
  const body = new TextEncoder().encode(JSON.stringify(payload));

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': vapidHeader,
      'Content-Type': 'application/json',
      'TTL': '86400',
    },
    body,
  });
  return { status: res.status, ok: res.ok };
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405 });
  }

  const auth = req.headers.get('authorization') || '';
  if (!NOTIFY_SECRET || auth !== `Bearer ${NOTIFY_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  if (!KV_URL || !KV_TOKEN || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return new Response(JSON.stringify({ error: 'Push not configured' }), { status: 503 });
  }

  let body;
  try { body = await req.json(); } catch { body = {}; }

  const payload = {
    title: body.title || 'The Bengal Reader',
    body: body.body || 'Data has been updated.',
    url: body.url || '/',
    tag: body.tag || 'bengal-update',
  };

  const subs = await listSubscriptions();
  const results = await Promise.allSettled(subs.map(s => sendPush(s, payload)));
  const sent = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
  const failed = results.length - sent;

  return new Response(JSON.stringify({ ok: true, sent, failed, total: subs.length }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
