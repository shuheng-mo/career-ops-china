#!/usr/bin/env node
/**
 * cv-version.mjs — version history for cv.md, which git cannot give us.
 *
 * cv.md and its per-track variants are gitignored (PII; the repo is public), so until
 * now a CV change left no trace: what changed, why, and what the CV looked like when a
 * given application went out were all unrecoverable. This keeps that history locally
 * under cv-evolve/ (also gitignored):
 *
 *   cv-evolve/versions/<ver>/cv.md, cv-auto.md, …   full snapshot per version
 *   cv-evolve/state.json                            current version + content hashes
 *   cv-evolve/CHANGELOG.md                          what changed, why, which fact ids
 *
 * Versions are dates (v20261025), suffixed -2, -3 on a busy day. A snapshot covers
 * cv.md AND every cv-*.md variant, because a variant is only meaningful against the
 * cv.md it was reworded from.
 *
 * `affected` is the propagation step: after a fact changes, which tailored CVs in
 * output/ still carry the old claim, and what is each one's application doing?
 * Not-yet-sent ones should be regenerated; already-sent ones must NOT be — the
 * interviewer holds the old version, so interview prep has to use it.
 *
 * CLI:
 *   node tools/cv-version.mjs init                                   # baseline snapshot
 *   node tools/cv-version.mjs status                                 # changed since last snapshot?
 *   node tools/cv-version.mjs commit -m "摘要" [--facts id,id] [--signal "依据"]
 *   node tools/cv-version.mjs log
 *   node tools/cv-version.mjs diff [<verA> [<verB>]] [--file cv-auto.md]   # default: last snapshot vs working copy
 *   node tools/cv-version.mjs affected [--since <ver>] [--fact <id>] [--claim "85%"] [--no-tracker]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { ROOT, EVOLVE_DIR, extractClaims, textContainsClaim, readLedger } from './cv-facts.mjs';

const VERSIONS_DIR = join(EVOLVE_DIR, 'versions');
const STATE_PATH = join(EVOLVE_DIR, 'state.json');
const CHANGELOG_PATH = join(EVOLVE_DIR, 'CHANGELOG.md');
const OUTPUT_DIR = join(ROOT, 'output');
const REPORTS_DIR = join(ROOT, 'reports');

// Local date, not UTC: a version cut at 08:00 Beijing time is that day's version.
const today = () => new Date().toLocaleDateString('sv-SE');
const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 12);
const die = msg => { console.error(`❌ ${msg}`); process.exit(1); };

function cvFiles() {
  if (!existsSync(join(ROOT, 'cv.md'))) die('cv.md not found in project root.');
  return ['cv.md', ...readdirSync(ROOT).filter(f => /^cv-.+\.md$/.test(f)).sort()];
}

function readState() {
  return existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf-8')) : null;
}

function requireState() {
  const s = readState();
  if (!s) die('cv-evolve is not initialized. Run: node tools/cv-version.mjs init');
  return s;
}

function snapshotText(ver, file) {
  const p = join(VERSIONS_DIR, ver, file);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}

function workingChanges(state) {
  const changed = [];
  for (const f of cvFiles()) {
    const h = sha(readFileSync(join(ROOT, f), 'utf-8'));
    if (state.hashes[f] !== h) changed.push(f);
  }
  for (const f of Object.keys(state.hashes)) {
    if (!existsSync(join(ROOT, f))) changed.push(`${f} (deleted)`);
  }
  return changed;
}

function nextVersion(state) {
  const base = `v${today().replace(/-/g, '')}`;
  const taken = new Set(state ? state.history.map(h => h.version) : []);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

function snapshot(ver) {
  const dir = join(VERSIONS_DIR, ver);
  mkdirSync(dir, { recursive: true });
  const hashes = {};
  for (const f of cvFiles()) {
    const text = readFileSync(join(ROOT, f), 'utf-8');
    writeFileSync(join(dir, f), text);
    hashes[f] = sha(text);
  }
  return hashes;
}

// Claims present in one text and gone from the other — the unit of "a fact changed".
function claimDelta(oldText, newText) {
  const a = oldText ? extractClaims(oldText) : new Set();
  const b = newText ? extractClaims(newText) : new Set();
  return { removed: [...a].filter(c => !b.has(c)), added: [...b].filter(c => !a.has(c)) };
}

function lineStat(oldText, newText) {
  const a = new Set((oldText || '').split('\n'));
  const b = new Set((newText || '').split('\n'));
  return { plus: [...b].filter(l => l.trim() && !a.has(l)).length, minus: [...a].filter(l => l.trim() && !b.has(l)).length };
}

function arg(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// ── commands ────────────────────────────────────────────────────────────────

function cmdInit() {
  if (readState()) die(`already initialized (current ${readState().current}). Use status / commit.`);
  mkdirSync(join(EVOLVE_DIR, 'dig'), { recursive: true });
  const ver = nextVersion(null);
  const hashes = snapshot(ver);
  writeFileSync(STATE_PATH, JSON.stringify({
    current: ver, hashes, history: [{ version: ver, date: today(), parent: null, summary: '基线快照' }],
  }, null, 2) + '\n');
  if (!existsSync(CHANGELOG_PATH)) {
    writeFileSync(CHANGELOG_PATH, `# CV Changelog\n\ncv.md 的每次变更：改了什么、依据什么信号、动了哪些 fact。由 \`tools/cv-version.mjs commit\` 追加，最新在下。\n\n`);
  }
  appendFileSync(CHANGELOG_PATH, `## ${ver} — ${today()}\n\n基线快照：${Object.keys(hashes).join('、')}。\n\n`);
  console.log(`✅ baseline ${ver}: ${Object.keys(hashes).join(', ')} → cv-evolve/versions/${ver}/`);
}

function cmdStatus() {
  const s = requireState();
  const changed = workingChanges(s);
  console.log(`current version: ${s.current} (${s.history.length} version(s))`);
  if (!changed.length) { console.log('working copy: clean — matches the last snapshot'); return; }
  console.log(`working copy: ${changed.length} file(s) changed since ${s.current}`);
  for (const f of changed) {
    const name = f.replace(/ \(deleted\)$/, '');
    const now = existsSync(join(ROOT, name)) ? readFileSync(join(ROOT, name), 'utf-8') : null;
    const { removed, added } = claimDelta(snapshotText(s.current, name), now);
    const { plus, minus } = lineStat(snapshotText(s.current, name), now);
    console.log(`  ${f}: +${plus} / -${minus} lines`
      + (removed.length ? `; claims removed: ${removed.join(', ')}` : '')
      + (added.length ? `; claims added: ${added.join(', ')}` : ''));
  }
  console.log('\nRecord it with: node tools/cv-version.mjs commit -m "摘要" [--facts id,id] [--signal "依据"]');
}

function cmdCommit(args) {
  const s = requireState();
  const summary = arg(args, '-m');
  if (!summary) die('commit needs -m "摘要" — the changelog is the point of versioning.');
  const changed = workingChanges(s);
  if (!changed.length) die(`nothing changed since ${s.current}.`);

  const parent = s.current;
  const ver = nextVersion(s);
  const details = changed.map(f => {
    const name = f.replace(/ \(deleted\)$/, '');
    const now = existsSync(join(ROOT, name)) ? readFileSync(join(ROOT, name), 'utf-8') : null;
    return { file: f, ...claimDelta(snapshotText(parent, name), now), ...lineStat(snapshotText(parent, name), now) };
  });
  const hashes = snapshot(ver);
  const facts = (arg(args, '--facts') || '').split(',').map(x => x.trim()).filter(Boolean);
  const signal = arg(args, '--signal') || '';

  s.current = ver;
  s.hashes = hashes;
  s.history.push({ version: ver, date: today(), parent, summary, facts, signal });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n');

  const lines = [`## ${ver} — ${today()}（基于 ${parent}）`, '', summary, ''];
  if (signal) lines.push(`- **依据：** ${signal}`);
  if (facts.length) lines.push(`- **Facts：** ${facts.map(f => `\`${f}\``).join('、')}`);
  for (const d of details) {
    lines.push(`- **${d.file}：** +${d.plus} / -${d.minus} 行`
      + (d.removed.length ? `；移除 ${d.removed.join('、')}` : '')
      + (d.added.length ? `；新增 ${d.added.join('、')}` : ''));
  }
  appendFileSync(CHANGELOG_PATH, lines.join('\n') + '\n\n');

  console.log(`✅ ${parent} → ${ver}: ${changed.join(', ')}`);
  if (details.some(d => d.removed.length)) {
    console.log(`\nClaims were removed or changed. See which tailored CVs still carry them:\n  node tools/cv-version.mjs affected --since ${parent}`);
  }
}

function cmdLog() {
  const s = requireState();
  for (const h of [...s.history].reverse()) {
    console.log(`${h.version}  ${h.date}  ${h.summary}${h.facts?.length ? `  [${h.facts.join(', ')}]` : ''}`);
  }
}

function cmdDiff(args) {
  const s = requireState();
  const file = arg(args, '--file') || 'cv.md';
  const pos = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--file');
  const [verA = s.current, verB] = pos;
  const pathA = join(VERSIONS_DIR, verA, file);
  const pathB = verB ? join(VERSIONS_DIR, verB, file) : join(ROOT, file);
  for (const p of [pathA, pathB]) if (!existsSync(p)) die(`not found: ${p}`);
  const r = spawnSync('diff', ['-u', '--label', `${verA}/${file}`, '--label', `${verB || 'working'}/${file}`, pathA, pathB], { encoding: 'utf-8' });
  process.stdout.write(r.stdout || `(no differences in ${file})\n`);
}

// Tailored CV → application. Reports record the CV they generated
// ("output/cv-candidate-<stem>.pdf"), and the tracker row links its report, so the
// report is the join key. A file no report mentions is reported as unlinked rather
// than guessed at.
function reportIndex() {
  const byStem = new Map();
  if (!existsSync(REPORTS_DIR)) return byStem;
  for (const r of readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'))) {
    const text = readFileSync(join(REPORTS_DIR, r), 'utf-8');
    for (const m of text.matchAll(/output\/(cv-candidate-[^\s)`'"]+?)\.(?:pdf|md)/g)) {
      if (!byStem.has(m[1])) byStem.set(m[1], r);
    }
  }
  return byStem;
}

const NOT_SENT = new Set(['Evaluated', 'Blocked']);
const IN_FLIGHT = new Set(['Applied', 'Responded', 'Interview']);

async function cmdAffected(args) {
  const claims = new Set();
  const why = [];

  const since = arg(args, '--since');
  if (since || (!arg(args, '--fact') && !arg(args, '--claim'))) {
    const s = requireState();
    // Default: what the working copy (or, if clean, the latest commit) removed.
    const dirty = workingChanges(s).length > 0;
    const from = since || (dirty ? s.current : s.history.at(-1).parent);
    if (!from) die('only the baseline exists — nothing has changed yet. Use --fact or --claim.');
    const toLabel = dirty && !since ? 'working copy' : s.current;
    for (const f of cvFiles()) {
      const oldT = snapshotText(from, f);
      const newT = readFileSync(join(ROOT, f), 'utf-8');
      for (const c of claimDelta(oldT, newT).removed) claims.add(c);
    }
    why.push(`claims removed between ${from} and ${toLabel}`);
  }
  const factId = arg(args, '--fact');
  if (factId) {
    const e = (readLedger() || []).find(x => x.id === factId);
    if (!e) die(`fact "${factId}" not in cv-evolve/ledger.yml`);
    for (const c of extractClaims(e.claim || '')) claims.add(c);
    why.push(`ledger ${factId}`);
  }
  const claimArg = arg(args, '--claim');
  if (claimArg) { for (const c of extractClaims(claimArg)) claims.add(c); why.push(`--claim ${claimArg}`); }

  if (!claims.size) { console.log(`No claims to look for (${why.join('; ')}).`); return; }
  console.log(`Looking for: ${[...claims].join(', ')}  (${why.join('; ')})\n`);

  const files = existsSync(OUTPUT_DIR) ? readdirSync(OUTPUT_DIR).filter(f => /^cv-candidate-.+\.md$/.test(f)).sort() : [];
  const hits = [];
  for (const f of files) {
    const text = readFileSync(join(OUTPUT_DIR, f), 'utf-8');
    const found = [...claims].filter(c => textContainsClaim(text, c));
    if (found.length) hits.push({ file: f, stem: basename(f, '.md'), found });
  }
  if (!hits.length) { console.log(`No tailored CV in output/ carries these claims (${files.length} scanned).`); return; }

  let apps = [];
  if (!args.includes('--no-tracker')) {
    try {
      const { listApplications } = await import('./tracker-backend.mjs');
      apps = await listApplications();
    } catch (err) {
      console.log(`(tracker unavailable — ${err.message.split('\n')[0]}; grouping by report only)\n`);
    }
  }
  const idx = reportIndex();
  const groups = { '未投 → 建议重新生成': [], '已投在途 → 不要改，面试按这一版准备': [], '已结束': [], '未关联到 tracker': [] };
  for (const h of hits) {
    const report = idx.get(h.stem);
    const num = report ? parseInt(report, 10) : null;
    const app = report && apps.find(a => String(a.report || '').includes(report) || (num && Number(a.num) === num));
    const label = app ? `#${app.num} ${app.company} · ${app.role} [${app.status}]` : report ? `report ${report}` : '';
    const line = `  ${h.file}${label ? `  ${label}` : ''}  — ${h.found.join(', ')}`;
    if (!app) groups['未关联到 tracker'].push(line);
    else if (NOT_SENT.has(app.status)) groups['未投 → 建议重新生成'].push(line);
    else if (IN_FLIGHT.has(app.status)) groups['已投在途 → 不要改，面试按这一版准备'].push(line);
    else groups['已结束'].push(line);
  }
  for (const [title, lines] of Object.entries(groups)) {
    if (!lines.length) continue;
    console.log(`${title}（${lines.length}）`);
    console.log(lines.join('\n') + '\n');
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = { init: cmdInit, status: cmdStatus, commit: cmdCommit, log: cmdLog, diff: cmdDiff, affected: cmdAffected };
if (!commands[cmd]) {
  console.log('usage: node tools/cv-version.mjs <init|status|commit|log|diff|affected> …  (see header)');
  process.exit(cmd ? 1 : 0);
}
await commands[cmd](rest);
