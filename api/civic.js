/**
 * api/civic.js — Real backend for the three CJP civic-tech apps
 *
 *   SwarmAudit       civic-failure reports   kind=report
 *   RTI Swarm        citizen RTI filings     kind=rti
 *   Resilient Guild  cohort waitlist         kind=waitlist
 *
 * GET  /api/civic?kind=report           → list recent reports
 * GET  /api/civic?kind=rti              → list recent RTI filings
 * POST /api/civic   { kind, ...fields } → insert one row (validated)
 *
 * Storage: Supabase REST API over fetch (no npm dependency, free tier).
 * Required env vars (set in Vercel → Settings → Environment Variables):
 *   SUPABASE_URL          https://<ref>.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role key (server-only, never shipped to client)
 *   CIVIC_WRITE_OPEN      optional "0" to freeze public writes (default open)
 *
 * Until these are set the function returns 503, and each app falls back to its
 * built-in demo data — so the live site is never broken by a missing backend.
 *
 * Apply db/schema.sql to your database first.
 */

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WRITES_OPEN = (process.env.CIVIC_WRITE_OPEN ?? '1') !== '0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });

// kind → { table, listColumns, listLimit }
const KINDS = {
  report: { table: 'civic_reports', cols: 'id,category,description,ward,city,lat,lng,status,created_at', limit: 200 },
  rti: { table: 'rti_filings', cols: 'id,subject,department,sector,city,status,filed_on,finding,created_at', limit: 200 },
  waitlist: { table: 'guild_waitlist', cols: 'id,track,created_at', limit: 0 }, // write-only (no public listing)
};

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ── Per-kind validation. Returns { row } or { error }. Never trusts the client. ─
function validate(kind, b) {
  if (kind === 'report') {
    const category = clean(b.category, 20).toLowerCase();
    const ok = ['roads', 'sanitation', 'health', 'education', 'utilities', 'other'];
    if (!ok.includes(category)) return { error: 'invalid category' };
    const description = clean(b.description, 1000);
    if (description.length < 5) return { error: 'description too short' };
    const ward = clean(b.ward, 120);
    if (!ward) return { error: 'ward required' };
    const lat = Number(b.lat), lng = Number(b.lng);
    return {
      row: {
        category,
        description,
        ward,
        city: clean(b.city, 120) || null,
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        status: 'pending',
      },
    };
  }
  if (kind === 'rti') {
    const subject = clean(b.subject, 240);
    if (subject.length < 3) return { error: 'subject too short' };
    const department = clean(b.department, 200);
    if (department.length < 2) return { error: 'department required' };
    return {
      row: {
        subject,
        department,
        sector: clean(b.sector, 80) || null,
        city: clean(b.city, 120) || null,
        status: 'filed',
      },
    };
  }
  if (kind === 'waitlist') {
    const track = clean(b.track, 80);
    if (!track) return { error: 'track required' };
    const name = clean(b.name, 120);
    if (!name) return { error: 'name required' };
    const lvl = clean(b.skill_level, 20).toLowerCase();
    return {
      row: {
        track,
        name,
        github: clean(b.github, 120) || null,
        skill_level: ['beginner', 'intermediate', 'advanced'].includes(lvl) ? lvl : '',
        note: clean(b.note, 1000) || null,
      },
    };
  }
  return { error: 'unknown kind' };
}

async function sb(path, init = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: 'backend not configured', hint: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY; apps fall back to demo data.' }, 503);
  }

  const url = new URL(req.url);
  const kind = (url.searchParams.get('kind') || '').toLowerCase();

  // ── GET: list ──────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const k = KINDS[kind];
    if (!k || k.limit === 0) return json({ error: 'not listable' }, 400);
    const res = await sb(`${k.table}?select=${k.cols}&order=created_at.desc&limit=${k.limit}`);
    if (!res.ok) return json({ error: `store ${res.status}` }, 502);
    return json({ items: await res.json() }, 200, { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' });
  }

  // ── POST: insert ─────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    if (!WRITES_OPEN) return json({ error: 'submissions are currently frozen' }, 423);
    let body;
    try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, 400); }

    const theKind = (body.kind || kind || '').toLowerCase();
    const k = KINDS[theKind];
    if (!k) return json({ error: 'unknown kind' }, 400);

    const { row, error } = validate(theKind, body);
    if (error) return json({ error }, 400);

    const res = await sb(k.table, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    if (res.status === 409) return json({ error: 'already submitted' }, 409);
    if (!res.ok) {
      let detail = `store ${res.status}`;
      try { const j = await res.json(); detail = j.message || j.hint || detail; } catch { /**/ }
      return json({ error: detail }, 502);
    }
    const created = (await res.json())[0] || row;
    return json({ ok: true, item: created }, 201);
  }

  return json({ error: 'method not allowed' }, 405);
}
