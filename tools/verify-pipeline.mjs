#!/usr/bin/env node
/**
 * verify-pipeline.mjs — Health check for career-ops pipeline integrity
 *
 * Checks:
 * 1. All statuses are canonical (per states.yml)
 * 2. No duplicate company+role entries
 * 3. All report links point to existing files
 * 4. Scores match format X.XX/5 or N/A or DUP
 * 5. All rows have proper pipe-delimited format
 * 6. No pending TSVs in tracker-additions/ (only in merged/ or archived/)
 * 7. states.yml canonical IDs for cross-system consistency
 *
 * Run: node tools/verify-pipeline.mjs    (or: npm run verify)
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
// Shared normalizers — these keep CJK codepoints. A local `[^a-z0-9]` strip
// erased every Chinese character, collapsing all CJK-named rows into one key
// and reporting them as duplicates of each other.
import { normalizeCompany, roleFuzzyMatch } from './tracker-backend.mjs';

// fileURLToPath handles spaces in path correctly (vs .pathname which encodes them as %20)
// Script lives in tools/; project root is one level up.
const CAREER_OPS = join(dirname(fileURLToPath(import.meta.url)), '..');
// Support both layouts: data/applications.md (boilerplate) and applications.md (original)
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const ADDITIONS_DIR = join(CAREER_OPS, 'batch/tracker-additions');
const REPORTS_DIR = join(CAREER_OPS, 'reports');
const STATES_FILE = existsSync(join(CAREER_OPS, 'templates/states.yml'))
  ? join(CAREER_OPS, 'templates/states.yml')
  : join(CAREER_OPS, 'states.yml');

// English canonical (matches templates/states.yml)
const CANONICAL_STATUSES = [
  'evaluated', 'applied', 'responded', 'interview',
  'offer', 'rejected', 'discarded', 'skip',
];

const ALIASES = {
  'sent': 'applied',
  'monitor': 'skip',
  // Chinese (matches templates/states.yml)
  '已评估': 'evaluated', '已申请': 'applied', '已投递': 'applied', '投递': 'applied',
  '已回复': 'responded', '面试中': 'interview', '面试': 'interview',
  '拿到offer': 'offer', '已offer': 'offer',
  '被拒': 'rejected', '已拒': 'rejected', '拒了': 'rejected',
  '自己放弃': 'discarded', '已放弃': 'discarded', '撤回': 'discarded',
  '不投': 'skip', '跳过': 'skip',
};

let errors = 0;
let warnings = 0;

function error(msg) { console.log(`❌ ${msg}`); errors++; }
function warn(msg) { console.log(`⚠️  ${msg}`); warnings++; }
function ok(msg) { console.log(`✅ ${msg}`); }

// --- Read applications.md ---
if (!existsSync(APPS_FILE)) {
  console.log('\n📊 No applications.md found. This is normal for a fresh setup.');
  console.log('   The file will be created when you evaluate your first offer.\n');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

// Column layout is NOT fixed: the md backend writes 9 columns while the Bitable
// export writes 11 (URL and Closed At added). Hardcoding indices made every
// report-link check read the URL column instead. Derive indices from the header.
const LEGACY_COLS = { '#': 1, date: 2, company: 3, role: 4, score: 5, status: 6, pdf: 7, report: 8, notes: 9 };

function findColumnMap(allLines) {
  for (const line of allLines) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map(s => s.trim().toLowerCase());
    // Header = the row naming the core columns; everything else is data or separator.
    if (!parts.includes('company') || !parts.includes('status')) continue;
    const map = {};
    parts.forEach((name, i) => { if (name) map[name] = i; });
    return map;
  }
  return null;
}

const cols = findColumnMap(lines) || LEGACY_COLS;
const expectedCols = Object.keys(cols).length;
const col = (parts, name) => (cols[name] !== undefined ? (parts[cols[name]] ?? '') : '');

const entries = [];
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  const parts = line.split('|').map(s => s.trim());
  const num = parseInt(col(parts, '#'));
  if (isNaN(num)) continue;
  entries.push({
    num,
    date: col(parts, 'date'),
    company: col(parts, 'company'),
    role: col(parts, 'role'),
    score: col(parts, 'score'),
    status: col(parts, 'status'),
    pdf: col(parts, 'pdf'),
    url: col(parts, 'url'),
    report: col(parts, 'report'),
    notes: col(parts, 'notes'),
  });
}

console.log(`\n📊 Checking ${entries.length} entries in applications.md\n`);

// --- Check 1: Canonical statuses ---
let badStatuses = 0;
for (const e of entries) {
  const clean = e.status.replace(/\*\*/g, '').trim().toLowerCase();
  // Strip trailing dates
  const statusOnly = clean.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();

  if (!CANONICAL_STATUSES.includes(statusOnly) && !ALIASES[statusOnly]) {
    error(`#${e.num}: Non-canonical status "${e.status}"`);
    badStatuses++;
  }

  // Check for markdown bold in status
  if (e.status.includes('**')) {
    error(`#${e.num}: Status contains markdown bold: "${e.status}"`);
    badStatuses++;
  }

  // Check for dates in status
  if (/\d{4}-\d{2}-\d{2}/.test(e.status)) {
    error(`#${e.num}: Status contains date: "${e.status}" — dates go in date column`);
    badStatuses++;
  }
}
if (badStatuses === 0) ok('All statuses are canonical');

// --- Check 2: Duplicates ---
// Group by normalized company, then compare roles within the group — same
// two-stage rule the tracker backend uses when deciding whether a row exists.
const byCompany = new Map();
let dupes = 0;
for (const e of entries) {
  const key = normalizeCompany(e.company);
  if (!key) continue;  // header/separator leftovers and the empty #0 record
  if (!byCompany.has(key)) byCompany.set(key, []);
  byCompany.get(key).push(e);
}
for (const group of byCompany.values()) {
  const seen = [];
  for (const e of group) {
    const hit = seen.find(g => roleFuzzyMatch(g[0].role, e.role));
    if (hit) hit.push(e); else seen.push([e]);
  }
  for (const g of seen) {
    if (g.length > 1) {
      warn(`Possible duplicates: ${g.map(e => `#${e.num}`).join(', ')} (${g[0].company} — ${g[0].role})`);
      dupes++;
    }
  }
}
if (dupes === 0) ok('No exact duplicates found');

// --- Check 3: Report links ---
let brokenReports = 0;
for (const e of entries) {
  const match = e.report.match(/\]\(([^)]+)\)/);
  if (!match) continue;
  const reportPath = join(CAREER_OPS, match[1]);
  if (!existsSync(reportPath)) {
    error(`#${e.num}: Report not found: ${match[1]}`);
    brokenReports++;
  }
}
if (brokenReports === 0) ok('All report links valid');

// --- Check 4: Score format ---
let badScores = 0;
for (const e of entries) {
  const s = e.score.replace(/\*\*/g, '').trim();
  if (!/^\d+\.?\d*\/5$/.test(s) && s !== 'N/A' && s !== 'DUP') {
    error(`#${e.num}: Invalid score format: "${e.score}"`);
    badScores++;
  }
}
if (badScores === 0) ok('All scores valid');

// --- Check 5: Row format ---
let badRows = 0;
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  if (/^\|[\s|:-]+\|$/.test(line) || line.includes('Empresa')) continue;
  const parts = line.split('|');
  if (parts.length < expectedCols) {
    error(`Row with <${expectedCols} columns: ${line.substring(0, 80)}...`);
    badRows++;
  }
}
if (badRows === 0) ok('All rows properly formatted');

// --- Check 6: Pending TSVs ---
let pendingTsvs = 0;
if (existsSync(ADDITIONS_DIR)) {
  const files = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
  pendingTsvs = files.length;
  if (pendingTsvs > 0) {
    warn(`${pendingTsvs} pending TSVs in tracker-additions/ (not merged)`);
  }
}
if (pendingTsvs === 0) ok('No pending TSVs');

// --- Check 7: Bold in scores ---
let boldScores = 0;
for (const e of entries) {
  if (e.score.includes('**')) {
    warn(`#${e.num}: Score has markdown bold: "${e.score}"`);
    boldScores++;
  }
}
if (boldScores === 0) ok('No bold in scores');

// --- Summary ---
console.log('\n' + '='.repeat(50));
console.log(`📊 Pipeline Health: ${errors} errors, ${warnings} warnings`);
if (errors === 0 && warnings === 0) {
  console.log('🟢 Pipeline is clean!');
} else if (errors === 0) {
  console.log('🟡 Pipeline OK with warnings');
} else {
  console.log('🔴 Pipeline has errors — fix before proceeding');
}

process.exit(errors > 0 ? 1 : 0);
