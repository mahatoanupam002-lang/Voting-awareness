-- db/schema.sql — The Bengal Reader · CJP civic-tech backend
--
-- Run this once against your Postgres database to create the tables that back
-- the three live apps (SwarmAudit, RTI Swarm, Resilient Skill Guild).
--
-- Designed for Supabase (free tier, no billing). To apply:
--   Supabase dashboard → SQL Editor → paste this file → Run.
-- Then set these env vars in your Vercel project (Settings → Environment Variables):
--   SUPABASE_URL          = https://<project-ref>.supabase.co
--   SUPABASE_SERVICE_KEY  = <service_role key>   (Settings → API → service_role)
--   CIVIC_WRITE_OPEN      = 1   (optional; set to 0 to freeze public writes)
--
-- The api/civic.js edge function reads these. Until they are set, the function
-- returns 503 and every app falls back to its built-in demo data — so the live
-- site is never broken by an un-provisioned backend.
--
-- It is also fine to run this on Neon/any Postgres; only the api/civic.js
-- adapter (which uses the Supabase REST API) is Supabase-specific.

-- ── SwarmAudit: crowd-sourced civic-failure reports ──────────────────────────
create table if not exists civic_reports (
  id          bigint generated always as identity primary key,
  category    text        not null check (category in ('roads','sanitation','health','education','utilities','other')),
  description text        not null check (char_length(description) between 5 and 1000),
  ward        text        not null check (char_length(ward) between 1 and 120),
  city        text,
  lat         double precision,
  lng         double precision,
  status      text        not null default 'pending' check (status in ('pending','escalated','resolved')),
  created_at  timestamptz not null default now()
);
create index if not exists civic_reports_created_idx on civic_reports (created_at desc);

-- ── RTI Swarm: citizen-filed RTI tracking entries ────────────────────────────
create table if not exists rti_filings (
  id          bigint generated always as identity primary key,
  subject     text        not null check (char_length(subject) between 3 and 240),
  department  text        not null check (char_length(department) between 2 and 200),
  sector      text,
  city        text,
  status      text        not null default 'filed' check (status in ('filed','pending','overdue','received','published')),
  filed_on    date        not null default current_date,
  finding     text,
  created_at  timestamptz not null default now()
);
create index if not exists rti_filings_created_idx on rti_filings (created_at desc);

-- ── Skill Guild: cohort waitlist signups ─────────────────────────────────────
create table if not exists guild_waitlist (
  id          bigint generated always as identity primary key,
  track       text        not null check (char_length(track) between 1 and 80),
  name        text        not null check (char_length(name) between 1 and 120),
  github      text,
  skill_level text        check (skill_level in ('beginner','intermediate','advanced','')),
  note        text        check (char_length(coalesce(note,'')) <= 1000),
  created_at  timestamptz not null default now(),
  unique (track, github)
);

-- ── Row Level Security ───────────────────────────────────────────────────────
-- The edge function authenticates with the service_role key, which bypasses
-- RLS. We still enable RLS so the public anon key cannot read/write directly,
-- keeping all access mediated through validated server code.
alter table civic_reports  enable row level security;
alter table rti_filings    enable row level security;
alter table guild_waitlist enable row level security;
-- (No public policies are created on purpose: only the service_role key, used
--  server-side by api/civic.js, may read/write.)
