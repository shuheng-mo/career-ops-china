#!/usr/bin/env node
/**
 * normalize-statuses.mjs — Clean non-canonical states in applications.md
 *
 * Maps all non-canonical statuses to canonical ones per templates/states.yml:
 *   Evaluated, Applied, Responded, Interview, Offer, Rejected, Discarded, SKIP
 *
 * Recognizes three input families and converts all to English canonical:
 *   - English canonical (already correct)
 *   - Spanish legacy aliases from upstream career-ops (Evaluada, Aplicado, etc.)
 *   - Chinese aliases (已评估, 已投递, 面试中, etc.)
 *
 * Also strips markdown bold (**) and dates from the status field,
 * moving duplicate-marker info to the notes column.
 *
 * Run: node career-ops/normalize-statuses.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// fileURLToPath handles spaces in path correctly (vs .pathname which encodes them as %20)
const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// Support both layouts: data/applications.md (boilerplate) and applications.md (original)
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const DRY_RUN = process.argv.includes('--dry-run');

// Canonical status mapping.
// Regex patterns detect a mix of: English canonical, Spanish legacy aliases
// (from upstream career-ops), and Chinese aliases. All map to English canonical
// (matches templates/states.yml).
function normalizeStatus(raw) {
  // Strip markdown bold
  let s = raw.replace(/\*\*/g, '').trim();
  const lower = s.toLowerCase();

  // Duplicate/repost variants → Discarded
  if (/^duplicado/i.test(s) || /^dup\b/i.test(s)) {
    return { status: 'Discarded', moveToNotes: raw.trim() };
  }

  // Spanish "cerrada/cancelada/descartada" (closed/cancelled) → Discarded
  if (/^cerrada$/i.test(s)) return { status: 'Discarded' };
  if (/^cancelada/i.test(s)) return { status: 'Discarded' };
  if (/^descartada$/i.test(s)) return { status: 'Discarded' };

  // Spanish "rechazada/rechazado" (rejected) → Rejected
  if (/^rechazada$/i.test(s)) return { status: 'Rejected' };
  if (/^rechazado\s+\d{4}/i.test(s)) return { status: 'Rejected' };

  // Spanish "aplicado" with date → Applied (strip date)
  if (/^aplicado\s+\d{4}/i.test(s)) return { status: 'Applied' };

  // Conditional/hold/monitor variants (Spanish + English) → Evaluated
  if (/^condicional$/i.test(s)) return { status: 'Evaluated' };
  if (/^hold$/i.test(s)) return { status: 'Evaluated' };
  if (/^monitor$/i.test(s)) return { status: 'Evaluated' };
  if (/^evaluar$/i.test(s)) return { status: 'Evaluated' };
  if (/^verificar$/i.test(s)) return { status: 'Evaluated' };

  // Geo blocker → SKIP
  if (/geo.?blocker/i.test(s)) return { status: 'SKIP' };

  // Repost #NNN → Discarded (notes preserved)
  if (/^repost/i.test(s)) return { status: 'Discarded', moveToNotes: raw.trim() };

  // Em dash / empty → Discarded
  if (s === '—' || s === '-' || s === '') return { status: 'Discarded' };

  // Already canonical (English) — just normalize casing
  const canonical = [
    'Evaluated', 'Applied', 'Responded', 'Interview',
    'Offer', 'Rejected', 'Discarded', 'SKIP',
  ];
  for (const c of canonical) {
    if (lower === c.toLowerCase()) return { status: c };
  }

  // Alias map: Spanish legacy + Chinese (matches templates/states.yml)
  const aliases = {
    // Spanish legacy → English canonical
    'evaluada': 'Evaluated',
    'aplicado': 'Applied', 'aplicada': 'Applied', 'enviada': 'Applied', 'sent': 'Applied',
    'respondido': 'Responded',
    'entrevista': 'Interview',
    'oferta': 'Offer',
    'rechazado': 'Rejected', 'rechazada': 'Rejected',
    'descartado': 'Discarded', 'descartada': 'Discarded', 'cerrada': 'Discarded',
    'no aplicar': 'SKIP', 'no_aplicar': 'SKIP', 'skip': 'SKIP',
    // Chinese aliases
    '已评估': 'Evaluated', '评估完成': 'Evaluated', '待决定': 'Evaluated',
    '已申请': 'Applied', '已投递': 'Applied', '已投': 'Applied', '投递': 'Applied',
    '已回复': 'Responded',
    '面试中': 'Interview', '面试': 'Interview', '一面': 'Interview', '二面': 'Interview', '三面': 'Interview',
    '拿到offer': 'Offer', '已offer': 'Offer',
    '被拒': 'Rejected', '拒了': 'Rejected', '已拒': 'Rejected', '拒信': 'Rejected',
    '自己放弃': 'Discarded', '已放弃': 'Discarded', '撤回': 'Discarded', '关闭': 'Discarded',
    '不投': 'SKIP', '跳过': 'SKIP',
  };
  if (aliases[lower] || aliases[s]) return { status: aliases[lower] || aliases[s] };

  // Unknown — flag it
  return { status: null, unknown: true };
}

// Read applications.md
if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to normalize.');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

let changes = 0;
let unknowns = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.startsWith('|')) continue;

  const parts = line.split('|').map(s => s.trim());
  // Format: ['', '#', 'fecha', 'empresa', 'rol', 'score', 'STATUS', 'pdf', 'report', 'notas', '']
  if (parts.length < 9) continue;
  if (parts[1] === '#' || parts[1] === '---' || parts[1] === '') continue;

  const num = parseInt(parts[1]);
  if (isNaN(num)) continue;

  const rawStatus = parts[6];
  const result = normalizeStatus(rawStatus);

  if (result.unknown) {
    unknowns.push({ num, rawStatus, line: i + 1 });
    continue;
  }

  if (result.status === rawStatus) continue; // Already canonical

  // Apply change
  const oldStatus = rawStatus;
  parts[6] = result.status;

  // Move DUPLICADO info to notes if needed
  if (result.moveToNotes && parts[9]) {
    const existing = parts[9] || '';
    if (!existing.includes(result.moveToNotes)) {
      parts[9] = result.moveToNotes + (existing ? '. ' + existing : '');
    }
  } else if (result.moveToNotes && !parts[9]) {
    parts[9] = result.moveToNotes;
  }

  // Also strip bold from score field
  if (parts[5]) {
    parts[5] = parts[5].replace(/\*\*/g, '');
  }

  // Reconstruct line
  const newLine = '| ' + parts.slice(1, -1).join(' | ') + ' |';
  lines[i] = newLine;
  changes++;

  console.log(`#${num}: "${oldStatus}" → "${result.status}"`);
}

if (unknowns.length > 0) {
  console.log(`\n⚠️  ${unknowns.length} unknown statuses:`);
  for (const u of unknowns) {
    console.log(`  #${u.num} (line ${u.line}): "${u.rawStatus}"`);
  }
}

console.log(`\n📊 ${changes} statuses normalized`);

if (!DRY_RUN && changes > 0) {
  // Backup first
  copyFileSync(APPS_FILE, APPS_FILE + '.bak');
  writeFileSync(APPS_FILE, lines.join('\n'));
  console.log('✅ Written to applications.md (backup: applications.md.bak)');
} else if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
} else {
  console.log('✅ No changes needed');
}
