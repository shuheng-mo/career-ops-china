#!/usr/bin/env node
/**
 * merge-tracker.mjs — Merge batch tracker additions into applications.md
 *
 * Handles multiple TSV formats:
 * - 9-col: num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes
 * - 8-col: num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport (no notes)
 * - Pipe-delimited (markdown table row): | col | col | ... |
 *
 * Dedup: company normalized + role fuzzy match + report number match
 * If duplicate with higher score → update in-place, update report link
 * Validates status against states.yml (rejects non-canonical, logs warning)
 *
 * Run: node tools/merge-tracker.mjs [--dry-run] [--verify]   (or: npm run merge)
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readProfileTracker } from './tracker-backend.mjs';

// fileURLToPath handles spaces in path correctly (vs .pathname which encodes them as %20)
// Script lives in tools/; project root is one level up.
const CAREER_OPS = join(dirname(fileURLToPath(import.meta.url)), '..');
// Support both layouts: data/applications.md (boilerplate) and applications.md (original)
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const ADDITIONS_DIR = join(CAREER_OPS, 'batch/tracker-additions');
const MERGED_DIR = join(ADDITIONS_DIR, 'merged');
const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');

// Tracker backend: md | bitable (from config/profile.yml)
const TRACKER_CFG = readProfileTracker();
const BACKEND = TRACKER_CFG.backend || 'md';

// Canonical states (must match templates/states.yml — English labels)
const CANONICAL_STATES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'];

function validateStatus(status) {
  const clean = status.replace(/\*\*/g, '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  const lower = clean.toLowerCase();

  for (const valid of CANONICAL_STATES) {
    if (valid.toLowerCase() === lower) return valid;
  }

  // Aliases — Chinese + common English synonyms
  const aliases = {
    'condicional': 'Evaluated', 'hold': 'Evaluated',
    'sent': 'Applied',
    'monitor': 'SKIP',
    'geo blocker': 'SKIP',
    // Chinese aliases (matching templates/states.yml)
    '已评估': 'Evaluated', '评估完成': 'Evaluated', '待决定': 'Evaluated',
    '已申请': 'Applied', '已投递': 'Applied', '已投': 'Applied', '投递': 'Applied',
    '已回复': 'Responded', '有回应': 'Responded', 'hr已联系': 'Responded',
    '面试中': 'Interview', '面试': 'Interview', '一面': 'Interview', '二面': 'Interview', '三面': 'Interview',
    '拿到offer': 'Offer', '已offer': 'Offer',
    '被拒': 'Rejected', '拒了': 'Rejected', '已拒': 'Rejected', '拒信': 'Rejected',
    '自己放弃': 'Discarded', '已放弃': 'Discarded', '撤回': 'Discarded', '关闭': 'Discarded',
    '不投': 'SKIP', '跳过': 'SKIP',
  };

  if (aliases[lower]) return aliases[lower];

  // Duplicate/Repost → Discarded
  if (/^(dup|repost)/i.test(lower)) return 'Discarded';

  console.warn(`⚠️  Non-canonical status "${status}" → defaulting to "Evaluated"`);
  return 'Evaluated';
}

function normalizeCompany(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function roleFuzzyMatch(a, b) {
  const wordsA = a.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const wordsB = b.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const overlap = wordsA.filter(w => wordsB.some(wb => wb.includes(w) || w.includes(wb)));
  return overlap.length >= 2;
}

function extractReportNum(reportStr) {
  const m = reportStr.match(/\[(\d+)\]/);
  return m ? parseInt(m[1]) : null;
}

function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function parseAppLine(line) {
  const parts = line.split('|').map(s => s.trim());
  // parts.length = cells + 2 (leading + trailing empties from `|...|`).
  //   9-col legacy layout  → parts.length === 11
  //   11-col extended      → parts.length === 13
  const cellCount = parts.length - 2;
  if (cellCount < 9) return null;
  const num = parseInt(parts[1]);
  if (isNaN(num) || num === 0) return null;
  // 11-col layout (2026-04-20): | # | Date | Company | Role | Score | Status | PDF | URL | Report | Notes | Closed At |
  // 9-col legacy layout:         | # | Date | Company | Role | Score | Status | PDF | Report | Notes |
  const hasExtended = cellCount >= 11;
  return {
    num,
    date: parts[2],
    company: parts[3],
    role: parts[4],
    score: parts[5],
    status: parts[6],
    pdf: parts[7],
    url: hasExtended ? parts[8] : '',
    report: hasExtended ? parts[9] : parts[8],
    notes: hasExtended ? (parts[10] || '') : (parts[9] || ''),
    closedAt: hasExtended ? (parts[11] || '') : '',
    raw: line,
  };
}

/**
 * Parse a TSV file content into a structured addition object.
 * Handles: 9-col TSV, 8-col TSV, pipe-delimited markdown.
 */
function parseTsvContent(content, filename) {
  content = content.trim();
  if (!content) return null;

  let parts;
  let addition;

  // Detect pipe-delimited (markdown table row)
  if (content.startsWith('|')) {
    parts = content.split('|').map(s => s.trim()).filter(Boolean);
    if (parts.length < 8) {
      console.warn(`⚠️  Skipping malformed pipe-delimited ${filename}: ${parts.length} fields`);
      return null;
    }
    // Format: num | date | company | role | score | status | pdf | report | notes
    addition = {
      num: parseInt(parts[0]),
      date: parts[1],
      company: parts[2],
      role: parts[3],
      score: parts[4],
      status: validateStatus(parts[5]),
      pdf: parts[6],
      report: parts[7],
      notes: parts[8] || '',
    };
  } else {
    // Tab-separated
    parts = content.split('\t');
    if (parts.length < 8) {
      console.warn(`⚠️  Skipping malformed TSV ${filename}: ${parts.length} fields`);
      return null;
    }

    // Detect column order: some TSVs have (status, score), others have (score, status)
    // Heuristic: if col4 looks like a score and col5 looks like a status, they're swapped
    const col4 = parts[4].trim();
    const col5 = parts[5].trim();
    const col4LooksLikeScore = /^\d+\.?\d*\/5$/.test(col4) || col4 === 'N/A' || col4 === 'DUP';
    const col5LooksLikeScore = /^\d+\.?\d*\/5$/.test(col5) || col5 === 'N/A' || col5 === 'DUP';
    const col4LooksLikeStatus = /^(evaluated|applied|responded|interview|offer|rejected|discarded|skip|dup|repost|condicional|hold|monitor)/i.test(col4);
    const col5LooksLikeStatus = /^(evaluated|applied|responded|interview|offer|rejected|discarded|skip|dup|repost|condicional|hold|monitor)/i.test(col5);

    let statusCol, scoreCol;
    if (col4LooksLikeStatus && !col4LooksLikeScore) {
      // Standard format: col4=status, col5=score
      statusCol = col4; scoreCol = col5;
    } else if (col4LooksLikeScore && col5LooksLikeStatus) {
      // Swapped format: col4=score, col5=status
      statusCol = col5; scoreCol = col4;
    } else if (col5LooksLikeScore && !col4LooksLikeScore) {
      // col5 is definitely score → col4 must be status
      statusCol = col4; scoreCol = col5;
    } else {
      // Default: standard format (status before score)
      statusCol = col4; scoreCol = col5;
    }

    addition = {
      num: parseInt(parts[0]),
      date: parts[1],
      company: parts[2],
      role: parts[3],
      status: validateStatus(statusCol),
      score: scoreCol,
      pdf: parts[6],
      report: parts[7],
      notes: parts[8] || '',
    };
  }

  if (isNaN(addition.num) || addition.num === 0) {
    console.warn(`⚠️  Skipping ${filename}: invalid entry number`);
    return null;
  }

  return addition;
}

// ---- Main ----

// Bitable backend: delegate to Bitable API, then regen applications.md from Bitable state.
if (BACKEND === 'bitable') {
  await mergeBitable();
  process.exit(0);
}

async function mergeBitable() {
  console.log(`📊 Backend: bitable (app_token=${TRACKER_CFG.bitable?.app_token?.slice(0,10)}...)\n`);

  if (!existsSync(ADDITIONS_DIR)) {
    console.log('No tracker-additions directory found.');
    return;
  }

  const tsvFiles = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
  if (tsvFiles.length === 0) {
    console.log('✅ No pending additions to merge.');
    return;
  }

  tsvFiles.sort((a, b) => (parseInt(a.replace(/\D/g, '')) || 0) - (parseInt(b.replace(/\D/g, '')) || 0));
  console.log(`📥 Found ${tsvFiles.length} pending TSVs`);

  const mod = await import('./backends/bitable-backend.mjs');
  const backend = mod.create(TRACKER_CFG);

  let added = 0, skipped = 0, errors = 0;

  for (const file of tsvFiles) {
    const content = readFileSync(join(ADDITIONS_DIR, file), 'utf-8').trim();
    const addition = parseTsvContent(content, file);
    if (!addition) { skipped++; continue; }

    if (DRY_RUN) {
      console.log(`  [dry] would add #${addition.num} ${addition.company} — ${addition.role}`);
      continue;
    }

    try {
      const result = await backend.addApplication(addition);
      if (result.inserted) {
        console.log(`➕ Added #${result.num}: ${addition.company} — ${addition.role} (${addition.score})`);
        added++;
      } else {
        console.log(`⏭  Dup (#${result.num}): ${addition.company} — ${addition.role}`);
        skipped++;
      }
    } catch (e) {
      console.error(`❌ ${file}: ${e.message.slice(0, 150)}`);
      errors++;
    }
  }

  // Move processed TSVs
  if (!DRY_RUN && (added + skipped) > 0) {
    if (!existsSync(MERGED_DIR)) mkdirSync(MERGED_DIR, { recursive: true });
    for (const file of tsvFiles) {
      renameSync(join(ADDITIONS_DIR, file), join(MERGED_DIR, file));
    }
    console.log(`\n✅ Moved ${tsvFiles.length} TSVs to merged/`);
  }

  console.log(`\n📊 Summary: +${added} added, ⏭  ${skipped} skipped, ❌ ${errors} errors`);

  // Regen applications.md snapshot from Bitable
  if (!DRY_RUN && added > 0) {
    console.log('\nRegenerating applications.md from Bitable...');
    const { execSync } = await import('child_process');
    try {
      execSync(`node ${join(CAREER_OPS, 'tools/sync-md-from-bitable.mjs')}`, { stdio: 'inherit' });
    } catch (e) {
      console.warn('⚠️  sync-md-from-bitable failed (Bitable writes succeeded; md snapshot stale).');
    }
  }
}

// ---- md backend (below) ----

// Read applications.md
if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to merge into.');
  process.exit(0);
}
const appContent = readFileSync(APPS_FILE, 'utf-8');
const appLines = appContent.split('\n');
const existingApps = [];
let maxNum = 0;

for (const line of appLines) {
  if (line.startsWith('|') && !line.includes('---') && !line.includes('Empresa')) {
    const app = parseAppLine(line);
    if (app) {
      existingApps.push(app);
      if (app.num > maxNum) maxNum = app.num;
    }
  }
}

console.log(`📊 Existing: ${existingApps.length} entries, max #${maxNum}`);

// Read tracker additions
if (!existsSync(ADDITIONS_DIR)) {
  console.log('No tracker-additions directory found.');
  process.exit(0);
}

const tsvFiles = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
if (tsvFiles.length === 0) {
  console.log('✅ No pending additions to merge.');
  process.exit(0);
}

// Sort files numerically for deterministic processing
tsvFiles.sort((a, b) => {
  const numA = parseInt(a.replace(/\D/g, '')) || 0;
  const numB = parseInt(b.replace(/\D/g, '')) || 0;
  return numA - numB;
});

console.log(`📥 Found ${tsvFiles.length} pending additions`);

let added = 0;
let updated = 0;
let skipped = 0;
const newLines = [];

for (const file of tsvFiles) {
  const content = readFileSync(join(ADDITIONS_DIR, file), 'utf-8').trim();
  const addition = parseTsvContent(content, file);
  if (!addition) { skipped++; continue; }

  // Check for duplicate by:
  // 1. Exact report number match
  // 2. Company + role fuzzy match
  const reportNum = extractReportNum(addition.report);
  let duplicate = null;

  if (reportNum) {
    // Check if this report number already exists
    duplicate = existingApps.find(app => {
      const existingReportNum = extractReportNum(app.report);
      return existingReportNum === reportNum;
    });
  }

  if (!duplicate) {
    // Exact entry number match
    duplicate = existingApps.find(app => app.num === addition.num);
  }

  if (!duplicate) {
    // Company + role fuzzy match
    const normCompany = normalizeCompany(addition.company);
    duplicate = existingApps.find(app => {
      if (normalizeCompany(app.company) !== normCompany) return false;
      return roleFuzzyMatch(addition.role, app.role);
    });
  }

  if (duplicate) {
    const newScore = parseScore(addition.score);
    const oldScore = parseScore(duplicate.score);

    if (newScore > oldScore) {
      console.log(`🔄 Update: #${duplicate.num} ${addition.company} — ${addition.role} (${oldScore}→${newScore})`);
      const lineIdx = appLines.indexOf(duplicate.raw);
      if (lineIdx >= 0) {
        // Preserve existing URL / Closed At; auto-fill Closed At if transitioning to terminal
        const TERMINAL = new Set(['Rejected', 'Discarded', 'SKIP', 'Offer']);
        const keepClosedAt = duplicate.closedAt || (TERMINAL.has(duplicate.status) ? addition.date : '');
        const updatedLine = `| ${duplicate.num} | ${addition.date} | ${addition.company} | ${addition.role} | ${addition.score} | ${duplicate.status} | ${duplicate.pdf} | ${duplicate.url || ''} | ${addition.report} | Re-eval ${addition.date} (${oldScore}→${newScore}). ${addition.notes} | ${keepClosedAt} |`;
        appLines[lineIdx] = updatedLine;
        updated++;
      }
    } else {
      console.log(`⏭️  Skip: ${addition.company} — ${addition.role} (existing #${duplicate.num} ${oldScore} >= new ${newScore})`);
      skipped++;
    }
  } else {
    // New entry — use the number from the TSV
    const entryNum = addition.num > maxNum ? addition.num : ++maxNum;
    if (addition.num > maxNum) maxNum = addition.num;

    // Auto-set Closed At for new entries that arrive already in a terminal state.
    const TERMINAL = new Set(['Rejected', 'Discarded', 'SKIP', 'Offer']);
    const closedAt = TERMINAL.has(addition.status) ? addition.date : '';
    const url = addition.url || '';
    const newLine = `| ${entryNum} | ${addition.date} | ${addition.company} | ${addition.role} | ${addition.score} | ${addition.status} | ${addition.pdf} | ${url} | ${addition.report} | ${addition.notes} | ${closedAt} |`;
    newLines.push(newLine);
    added++;
    console.log(`➕ Add #${entryNum}: ${addition.company} — ${addition.role} (${addition.score})`);
  }
}

// Insert new lines after the header (line index of first data row)
if (newLines.length > 0) {
  // Find header separator (|---|...) and insert after it
  let insertIdx = -1;
  for (let i = 0; i < appLines.length; i++) {
    if (appLines[i].includes('---') && appLines[i].startsWith('|')) {
      insertIdx = i + 1;
      break;
    }
  }
  if (insertIdx >= 0) {
    appLines.splice(insertIdx, 0, ...newLines);
  }
}

// Write back
if (!DRY_RUN) {
  writeFileSync(APPS_FILE, appLines.join('\n'));

  // Move processed files to merged/
  if (!existsSync(MERGED_DIR)) mkdirSync(MERGED_DIR, { recursive: true });
  for (const file of tsvFiles) {
    renameSync(join(ADDITIONS_DIR, file), join(MERGED_DIR, file));
  }
  console.log(`\n✅ Moved ${tsvFiles.length} TSVs to merged/`);
}

console.log(`\n📊 Summary: +${added} added, 🔄${updated} updated, ⏭️${skipped} skipped`);
if (DRY_RUN) console.log('(dry-run — no changes written)');

// Optional verify
if (VERIFY && !DRY_RUN) {
  console.log('\n--- Running verification ---');
  const { execSync } = await import('child_process');
  try {
    execSync(`node ${join(CAREER_OPS, 'tools/verify-pipeline.mjs')}`, { stdio: 'inherit' });
  } catch (e) {
    process.exit(1);
  }
}
