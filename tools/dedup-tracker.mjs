#!/usr/bin/env node
/**
 * dedup-tracker.mjs — Collapse duplicate company+role entries in the tracker.
 *
 * Within one company, entries whose roles fuzzy-match are one cluster. The
 * highest-scoring entry is the keeper; it inherits the most advanced status
 * found anywhere in the cluster (an active application outranks a terminal one).
 *
 * Backend behaviour differs on purpose:
 *   - md:      losers are deleted from the table (a .bak is written first).
 *   - bitable: losers are marked Discarded with `DUP of #N` in notes, NOT
 *              deleted. The abstraction layer has no delete, and Bitable's
 *              +record-delete is a high-risk-write needing --yes, which an
 *              agent must not supply on its own. Marking also fits Bitable
 *              better: records carry history, and Discarded rows are already
 *              filtered out of the funnel views.
 *
 * Run: node tools/dedup-tracker.mjs [--dry-run]   (or: npm run dedup)
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  listApplications, updateMany, getBackend,
  normalizeCompany, roleFuzzyMatch,
} from './tracker-backend.mjs';

const CAREER_OPS = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const DRY_RUN = process.argv.includes('--dry-run');

// Status advancement order (higher = more advanced in the pipeline).
// Applied outranks Rejected: an active application beats a terminal state.
// Blocked sits just above Evaluated — it is an active state awaiting evidence.
const STATUS_RANK = {
  skip: 0,
  discarded: 1,
  evaluated: 2,
  blocked: 3,
  rejected: 4,
  applied: 5,
  responded: 6,
  interview: 7,
  offer: 8,
};

function parseScore(s) {
  const m = String(s || '').replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

const backend = await getBackend();
const apps = (await listApplications()).filter(a => a.num > 0);

console.log(`\n📊 Checking ${apps.length} entries (${backend.backendName} backend)\n`);

// Group by normalized company. normalizeCompany/roleFuzzyMatch come from the
// shared layer because the local copies here used /[^a-z0-9 ]/ , which erased
// every CJK codepoint — all Chinese company names collapsed to "" and role
// matching then had no tokens to compare, so this script silently did nothing
// on a tracker that is almost entirely Chinese.
const groups = new Map();
for (const a of apps) {
  const key = normalizeCompany(a.company);
  if (!key) continue;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(a);
}

const clusters = [];
for (const entries of groups.values()) {
  if (entries.length < 2) continue;
  const used = new Set();
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const cluster = [entries[i]];
    used.add(i);
    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;
      if (roleFuzzyMatch(entries[i].role, entries[j].role)) {
        cluster.push(entries[j]);
        used.add(j);
      }
    }
    if (cluster.length > 1) clusters.push(cluster);
  }
}

const updates = [];
const losers = [];

for (const cluster of clusters) {
  cluster.sort((a, b) => parseScore(b.score) - parseScore(a.score));
  const keeper = cluster[0];

  let bestStatus = keeper.status;
  let bestRank = STATUS_RANK[String(keeper.status).toLowerCase()] ?? 0;
  for (const e of cluster.slice(1)) {
    const rank = STATUS_RANK[String(e.status).toLowerCase()] ?? 0;
    if (rank > bestRank) { bestRank = rank; bestStatus = e.status; }
  }

  console.log(`🔁 ${keeper.company} — ${keeper.role}`);
  console.log(`   keep #${keeper.num} (${keeper.score || 'N/A'})`);

  if (bestStatus !== keeper.status) {
    const from = cluster.find(e => e.status === bestStatus);
    updates.push({ num: keeper.num, status: bestStatus });
    console.log(`   📝 #${keeper.num}: status ${keeper.status} → ${bestStatus} (from #${from?.num})`);
  }

  for (const dup of cluster.slice(1)) {
    losers.push({ keeper, dup });
    console.log(`   🗑️  #${dup.num} (${dup.score || 'N/A'}, ${dup.status})`);
  }
}

if (losers.length === 0 && updates.length === 0) {
  console.log('✅ No duplicates found');
  process.exit(0);
}

if (DRY_RUN) {
  console.log(`\n📊 ${losers.length} duplicates, ${updates.length} status promotions (dry-run — nothing written)`);
  process.exit(0);
}

if (backend.backendName === 'bitable') {
  // Mark, don't delete — see the header comment.
  for (const { keeper, dup } of losers) {
    const note = `DUP of #${keeper.num}`;
    updates.push({
      num: dup.num,
      status: 'Discarded',
      notes: (dup.notes || '').includes(note) ? dup.notes : `${note}；${dup.notes || ''}`,
    });
  }
  const { updated, missing } = await updateMany(updates);
  if (missing.length) console.log(`⚠️  未找到: ${missing.join(', ')}`);
  console.log(`\n✅ ${updated} records updated in Bitable (${losers.length} marked Discarded + DUP of #N)`);
  console.log('   Run `npm run tracker:export` to refresh the md snapshot.');
} else {
  // md backend: apply promotions through the layer, then physically drop rows.
  if (updates.length) await updateMany(updates);

  const lines = readFileSync(APPS_FILE, 'utf-8').split('\n');
  const dropNums = new Set(losers.map(l => l.dup.num));
  const kept = lines.filter(line => {
    if (!line.startsWith('|')) return true;
    const num = parseInt(line.split('|')[1]?.trim(), 10);
    return isNaN(num) || !dropNums.has(num);
  });
  copyFileSync(APPS_FILE, APPS_FILE + '.bak');
  writeFileSync(APPS_FILE, kept.join('\n'));
  console.log(`\n✅ ${losers.length} duplicates removed from applications.md (backup: applications.md.bak)`);
}
