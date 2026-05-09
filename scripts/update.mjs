/**
 * scripts/update.mjs
 * Weekly auto-update for The Bengal Reader.
 * Run by GitHub Actions every Sunday night.
 *
 * Sources checked:
 *   1. enforcement.gov.in — ED press releases (Bengal-filtered)
 *   2. Google News RSS — per-case keyword queries
 *   3. cbi.gov.in — CBI press releases (Bengal-filtered)
 *
 * What it does:
 *   - Adds timeline entries for confirmed new developments
 *   - Updates lastUpdated field on matched cases
 *   - Bumps meta.json autoChecked timestamp
 *   - Updates sitemap.xml lastmod dates
 *   - Never deletes existing data — only appends
 *
 * To add a new case to auto-tracking: add its id and keywords to CASE_KEYWORDS below.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// ── Keywords per case ─────────────────────────────────────────────────────────
const CASE_KEYWORDS = {
  'saradha':              ['Saradha chit fund', 'Saradha scam court', 'Madan Mitra Saradha', 'Kunal Ghosh Saradha'],
  'rose-valley':          ['Rose Valley ponzi', 'Rose Valley court', 'Sudip Bandyopadhyay court'],
  'narada':               ['Narada sting case', 'Narada case Calcutta', 'Firhad Hakim court'],
  'ssc-scam':             ['SSC recruitment scam Bengal', 'Partha Chatterjee court SSC', 'Manik Bhattacharya SSC', 'school job scam Bengal'],
  'cattle-trafficking':   ['Anubrata Mondal court', 'cattle smuggling Bengal CBI', 'Sukanya Mondal court'],
  'coal-mafia':           ['Vinay Mishra coal Bengal', 'coal mafia Bengal ED', 'Anup Majee Bengal'],
  'ration-scam':          ['Jyoti Priya Mallick court', 'ration scam Bengal ED', 'PDS scam Bengal'],
  'post-poll-violence-2021': ['post poll violence Bengal 2021 CBI', 'Bengal violence 2021 court', 'NHRC Bengal 2021'],
};

// ── Step summary helper ───────────────────────────────────────────────────────
const summaryLines = [];
function summaryWrite(line) {
  summaryLines.push(line);
  console.log(line.replace(/[*#`]/g, '').trim());
}
function flushSummary() {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) {
    try {
      writeFileSync(path, summaryLines.join('\n') + '\n', { flag: 'a' });
    } catch { /* non-fatal */ }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtMonthYear(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getFullYear()} ${months[d.getMonth()]}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function thisMonth() {
  return today().slice(0, 7);
}

async function safeFetch(url, opts = {}) {
  try {
    const res = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': 'BengalReader/1.0 (public transparency project)', ...opts.headers },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    console.warn(`  fetch failed: ${url} — ${e.message}`);
    return null;
  }
}

// ── Google News RSS ───────────────────────────────────────────────────────────
async function fetchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const xml = await safeFetch(url);
  if (!xml) return [];

  const items = [];
  const rx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = rx.exec(xml)) !== null) {
    const body = m[1];
    const title = (/<title><!\[CDATA\[([\s\S]*?)\]\]>/.exec(body) || /<title>([\s\S]*?)<\/title>/.exec(body) || [])[1];
    const pub   = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(body) || [])[1];
    if (title && pub) {
      const date = new Date(pub);
      if (!isNaN(date)) items.push({ title: title.replace(/<[^>]+>/g, '').trim(), date });
    }
  }
  return items;
}

// ── ED press releases ─────────────────────────────────────────────────────────
async function fetchEDReleases() {
  const html = await safeFetch('https://enforcement.gov.in/press-releases');
  if (!html) return [];

  const results = [];
  const rx = /href="([^"]*(?:press|release|attachment)[^"]*)"[^>]*>([\s\S]{10,300}?)<\/a>/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (text.length > 15 && /Bengal|Kolkata|Calcutta|Saradha|SSC|Narada|Rose Valley|Mallick|Mondal|Mishra|coal|cattle|ration/i.test(text)) {
      results.push({ url: m[1], title: text.slice(0, 200) });
    }
  }
  return results;
}

// ── CBI press releases ────────────────────────────────────────────────────────
async function fetchCBIReleases() {
  const html = await safeFetch('https://cbi.gov.in/press-release');
  if (!html) return [];

  const results = [];
  const rx = /href="([^"]*press[^"]*)"[^>]*>([\s\S]{10,300}?)<\/a>/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (text.length > 15 && /Bengal|Kolkata|Saradha|SSC|Narada|Rose Valley|Mondal|cattle|coal|ration/i.test(text)) {
      results.push({ url: m[1], title: text.slice(0, 200) });
    }
  }
  return results;
}

// ── Already-seen guard ────────────────────────────────────────────────────────
function alreadySeen(timeline, sourceUrl, weekKey) {
  return timeline.some(t =>
    (sourceUrl && t.autoFrom === sourceUrl) ||
    (t.autoAdded && t.autoAdded.slice(0, 7) === weekKey)
  );
}

// ── Sitemap lastmod updater ───────────────────────────────────────────────────
function updateSitemap(dateStr) {
  const sitemapPath = 'sitemap.xml';
  if (!existsSync(sitemapPath)) return;
  try {
    const xml = readFileSync(sitemapPath, 'utf-8');
    const updated = xml.replace(/<lastmod>[^<]+<\/lastmod>/g, `<lastmod>${dateStr}</lastmod>`);
    writeFileSync(sitemapPath, updated);
  } catch (e) {
    console.warn('  sitemap update failed:', e.message);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const runDate = today();
  summaryWrite(`# Bengal Reader — Weekly Update ${runDate}`);
  summaryWrite('');

  const cases = JSON.parse(readFileSync('data/cases.json', 'utf-8'));
  const meta  = JSON.parse(readFileSync('data/meta.json',  'utf-8'));
  const now   = new Date();
  const cutoff = new Date(now - 8 * 86400_000);

  let totalChanges = 0;
  const updatedCases = [];
  const errors = [];

  // 1. ED press releases
  summaryWrite('## Enforcement Directorate');
  let edReleases = [];
  try {
    edReleases = await fetchEDReleases();
    summaryWrite(`Found **${edReleases.length}** Bengal-relevant ED releases.`);
  } catch (e) {
    errors.push(`ED fetch failed: ${e.message}`);
    summaryWrite(`⚠️ ED fetch failed: ${e.message}`);
  }
  for (const c of cases) {
    try {
      const kws = CASE_KEYWORDS[c.id] || [];
      for (const r of edReleases) {
        if (kws.some(kw => r.title.toLowerCase().includes(kw.toLowerCase().split(' ')[0]))) {
          if (!alreadySeen(c.timeline, r.url, thisMonth())) {
            c.timeline.push({ date: fmtMonthYear(now), event: `ED: ${r.title}`, autoAdded: runDate, autoFrom: r.url, source: 'ED press release' });
            c.lastUpdated = thisMonth();
            totalChanges++;
            updatedCases.push(c.id);
            summaryWrite(`- ✅ **${c.id}**: ${r.title.slice(0, 80)}…`);
          }
        }
      }
    } catch (e) {
      errors.push(`ED match error for ${c.id}: ${e.message}`);
    }
  }
  summaryWrite('');

  // 2. CBI press releases
  summaryWrite('## Central Bureau of Investigation');
  let cbiReleases = [];
  try {
    cbiReleases = await fetchCBIReleases();
    summaryWrite(`Found **${cbiReleases.length}** Bengal-relevant CBI releases.`);
  } catch (e) {
    errors.push(`CBI fetch failed: ${e.message}`);
    summaryWrite(`⚠️ CBI fetch failed: ${e.message}`);
  }
  for (const c of cases) {
    try {
      const kws = CASE_KEYWORDS[c.id] || [];
      for (const r of cbiReleases) {
        if (kws.some(kw => r.title.toLowerCase().includes(kw.toLowerCase().split(' ')[0]))) {
          if (!alreadySeen(c.timeline, r.url, thisMonth())) {
            c.timeline.push({ date: fmtMonthYear(now), event: `CBI: ${r.title}`, autoAdded: runDate, autoFrom: r.url, source: 'CBI press release' });
            c.lastUpdated = thisMonth();
            totalChanges++;
            updatedCases.push(c.id);
            summaryWrite(`- ✅ **${c.id}**: ${r.title.slice(0, 80)}…`);
          }
        }
      }
    } catch (e) {
      errors.push(`CBI match error for ${c.id}: ${e.message}`);
    }
  }
  summaryWrite('');

  // 3. Google News RSS per case
  summaryWrite('## Google News (per case)');
  for (const c of cases) {
    const kws = CASE_KEYWORDS[c.id];
    if (!kws) { summaryWrite(`- ⏭️ **${c.id}**: no keywords — skipped`); continue; }

    try {
      const items = await fetchGoogleNews(kws[0]);
      const recent = items.filter(n => n.date > cutoff);

      if (recent.length >= 3 && !alreadySeen(c.timeline, null, thisMonth())) {
        const headline = recent[0].title.slice(0, 120);
        c.timeline.push({ date: fmtMonthYear(now), event: `${recent.length} news reports this week. Latest: "${headline}"`, autoAdded: runDate, source: 'Google News RSS' });
        c.lastUpdated = thisMonth();
        totalChanges++;
        updatedCases.push(c.id);
        summaryWrite(`- ✅ **${c.id}**: ${recent.length} articles — "${headline.slice(0, 60)}…"`);
      } else {
        summaryWrite(`- · **${c.id}**: ${recent.length} recent article(s) — no update`);
      }
    } catch (e) {
      errors.push(`News fetch error for ${c.id}: ${e.message}`);
      summaryWrite(`- ⚠️ **${c.id}**: fetch error — ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 600));
  }
  summaryWrite('');

  // 4. Update meta and sitemap
  meta.autoChecked = runDate;
  updateSitemap(runDate);

  // 5. Write files
  writeFileSync('data/cases.json', JSON.stringify(cases, null, 2));
  writeFileSync('data/meta.json',  JSON.stringify(meta,  null, 2));

  // 6. Summary footer
  summaryWrite('## Result');
  summaryWrite(`- **${totalChanges}** timeline entries added across **${new Set(updatedCases).size}** cases`);
  summaryWrite(`- \`meta.autoChecked\` updated to \`${runDate}\``);
  if (errors.length) {
    summaryWrite('');
    summaryWrite('### ⚠️ Non-fatal errors');
    errors.forEach(e => summaryWrite(`- ${e}`));
  } else {
    summaryWrite('- No errors');
  }

  flushSummary();
  process.exit(errors.length > 0 ? 0 : 0); // always exit 0 — partial success is fine
}

main().catch(err => {
  summaryWrite(`\n## ❌ Script crashed\n\`\`\`\n${err.stack}\n\`\`\``);
  flushSummary();
  console.error('Update script crashed:', err);
  process.exit(1);
});
