/**
 * api/subscribe.js — Web Push subscription endpoint
 *
 * POST /api/subscribe  { subscription: PushSubscription }   → store
 * DELETE /api/subscribe { subscription: PushSubscription }  → remove
 *
 * Storage: Vercel KV (env vars KV_REST_API_URL + KV_REST_API_TOKEN).
 * Each subscription is stored as kv key "sub:<sha256(endpoint)>".
 *
 * Required env vars:
 *   KV_REST_API_URL      — Vercel KV REST URL
 *   KV_REST_API_TOKEN    — Vercel KV REST token
 *   VAPID_PUBLIC_KEY     — base64url-encoded VAPID public key
 */

export const config = { runtime: 'edge' };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvSet(key, value) {
  const res = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return res.ok;
}

async function kvDel(key) {
  const res = await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  return res.ok;
}

async function subKey(endpoint) {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(endpoint));
  const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `sub:${hex.slice(0, 32)}`;
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const cors = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (!KV_URL || !KV_TOKEN) {
    return new Response(JSON.stringify({ error: 'KV not configured' }), {
      status: 503, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const sub = body.subscription;
  if (!sub || !sub.endpoint) {
    return new Response(JSON.stringify({ error: 'Missing subscription' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const key = await subKey(sub.endpoint);

  if (req.method === 'DELETE') {
    await kvDel(key);
    return new Response(JSON.stringify({ ok: true, action: 'unsubscribed' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'POST') {
    const stored = { endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() };
    await kvSet(key, stored);
    return new Response(JSON.stringify({ ok: true, action: 'subscribed', vapidPublicKey: process.env.VAPID_PUBLIC_KEY }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405, headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
