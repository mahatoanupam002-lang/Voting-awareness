#!/usr/bin/env node
/**
 * extract-constituencies.mjs
 * One-time script: reads the inline RESULTS array from constituencies.html
 * and writes public/data/constituencies.json
 *
 * Usage: node scripts/extract-constituencies.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const HTML_PATH = join(ROOT, 'public', 'constituencies.html');
const OUT_PATH  = join(ROOT, 'public', 'data', 'constituencies.json');

// ── Read source HTML ────────────────────────────────────────────────────────
const html = readFileSync(HTML_PATH, 'utf8');

// ── Extract RESULTS array ───────────────────────────────────────────────────
const startMarker = 'const RESULTS = [';
const startIdx    = html.indexOf(startMarker);
if (startIdx === -1) {
  console.error('ERROR: Could not find "const RESULTS = [" in constituencies.html');
  process.exit(1);
}

// Find the matching closing '];'
let depth   = 0;
let inStr   = false;
let strChar = '';
let endIdx  = -1;

for (let i = startIdx + startMarker.length - 1; i < html.length; i++) {
  const ch = html[i];
  if (inStr) {
    if (ch === '\\') { i++; continue; } // escape
    if (ch === strChar) inStr = false;
    continue;
  }
  if (ch === '"' || ch === "'" || ch === '`') {
    inStr = true; strChar = ch; continue;
  }
  if (ch === '[') { depth++; continue; }
  if (ch === ']') {
    depth--;
    if (depth === 0) { endIdx = i; break; }
  }
}

if (endIdx === -1) {
  console.error('ERROR: Could not find end of RESULTS array');
  process.exit(1);
}

const arrayText = html.slice(startIdx + startMarker.length - 1, endIdx + 1);
// arrayText is now the raw JS array literal

// ── Evaluate it safely using Function constructor ───────────────────────────
let seats;
try {
  // eslint-disable-next-line no-new-func
  seats = new Function(`return ${arrayText}`)();
} catch (err) {
  console.error('ERROR: Failed to parse RESULTS array:', err.message);
  process.exit(1);
}

console.log(`Extracted ${seats.length} seat records`);

// ── Extract DISTRICTS array ──────────────────────────────────────────────────
const distStartMarker = 'const DISTRICTS = [';
const distStartIdx    = html.indexOf(distStartMarker);
let districts         = [];

if (distStartIdx !== -1) {
  let d = 0; let inS = false; let sChar = ''; let distEndIdx = -1;
  for (let i = distStartIdx + distStartMarker.length - 1; i < html.length; i++) {
    const ch = html[i];
    if (inS) {
      if (ch === '\\') { i++; continue; }
      if (ch === sChar) inS = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inS = true; sChar = ch; continue; }
    if (ch === '[') { d++; continue; }
    if (ch === ']') {
      d--;
      if (d === 0) { distEndIdx = i; break; }
    }
  }
  if (distEndIdx !== -1) {
    const distArrayText = html.slice(distStartIdx + distStartMarker.length - 1, distEndIdx + 1);
    try {
      // eslint-disable-next-line no-new-func
      districts = new Function(`return ${distArrayText}`)();
      console.log(`Extracted ${districts.length} district records`);
    } catch (e) {
      console.warn('WARN: Could not parse DISTRICTS array:', e.message);
    }
  }
}

// ── Build output JSON ────────────────────────────────────────────────────────
const output = {
  meta: {
    generatedAt:  new Date().toISOString(),
    source:       'constituencies.html inline RESULTS array',
    totalSeats:   seats.length,
    description:  'West Bengal Assembly Election 2026 — 294 constituency results',
  },
  districts,
  seats: seats.map(s => ({
    ac:         s.ac,
    name:       s.name,
    district:   s.district,
    winner:     s.winner    || null,
    winParty:   s.winParty  || null,
    loser:      s.loser     || null,
    loseParty:  s.loseParty || null,
    margin:     s.margin    ?? null,
    verified:   s.verified  ?? false,
    notable:    s.notable   ?? false,
    note:       s.note      || '',
  })),
};

// ── Write output ─────────────────────────────────────────────────────────────
mkdirSync(join(ROOT, 'public', 'data'), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf8');

console.log(`Written → ${OUT_PATH}`);
console.log(`  Seats: ${output.seats.length}`);
console.log(`  Districts: ${output.districts.length}`);
