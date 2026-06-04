# Civic-tech backend — activation

The three CJP apps (SwarmAudit, RTI Swarm, Resilient Skill Guild) run on a real
backend via `api/civic.js` (a Vercel Edge function) backed by Postgres.

**Until you connect a database, the apps fall back to their built-in sample data
and nothing breaks.** Activating the backend makes submissions persist and real
entries appear alongside the samples.

## One-time setup (Supabase, free tier — no billing)

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query →** paste [`db/schema.sql`](./schema.sql) → **Run**.
   This creates `civic_reports`, `rti_filings`, `guild_waitlist` (with RLS on).
3. In Supabase, **Settings → API**, copy:
   - **Project URL** → `https://<ref>.supabase.co`
   - **service_role** key (secret — server-side only).
4. In your **Vercel project → Settings → Environment Variables**, add:

   | Name | Value |
   |------|-------|
   | `SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `SUPABASE_SERVICE_KEY` | the `service_role` key |
   | `CIVIC_WRITE_OPEN` | `1` (set `0` to freeze public writes) |

5. Redeploy (any push to `main` triggers it). Done — the apps now read/write live data.

## Endpoints (`api/civic.js`)

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/civic?kind=report` | list recent SwarmAudit reports |
| `GET`  | `/api/civic?kind=rti`    | list recent RTI filings |
| `POST` | `/api/civic` `{kind:'report', category, description, ward, city, lat, lng}` | submit a civic-failure report |
| `POST` | `/api/civic` `{kind:'rti', subject, department, sector, city}` | record an RTI filing |
| `POST` | `/api/civic` `{kind:'waitlist', track, name, github, skill_level, note}` | Skill Guild waitlist signup |

All input is validated and length-capped server-side. The `service_role` key is
never sent to the browser — only `api/civic.js` uses it. Without the env vars the
function returns `503` and the front-ends silently use sample data.

## Using Neon (or any Postgres) instead

`db/schema.sql` is standard Postgres and runs anywhere. Only `api/civic.js` is
Supabase-REST-specific; to use Neon, swap the `sb()` helper for the
`@neondatabase/serverless` driver (adds one dependency) — the validation and
routing stay identical.
