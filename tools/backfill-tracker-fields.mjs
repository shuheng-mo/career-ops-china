#!/usr/bin/env node
/**
 * backfill-tracker-fields.mjs — One-shot: populate URL and Closed At
 * for existing tracker records that predate those fields.
 *
 * Sources:
 *   URL        — extracted from reports/{NNN}-*-{date}.md `**URL：**` header line.
 *                Matched to tracker rows via the Report markdown link (e.g., `[089](reports/038-...)`).
 *   Closed At  — for rows already in a terminal status (Rejected/Discarded/SKIP/Offer)
 *                and missing Closed At, set to the row's existing Date (best-effort;
 *                we don't know when the state actually transitioned).
 *
 * Runs against the configured backend (md or bitable) via tracker-backend.mjs.
 * Idempotent: skips rows that already have URL / Closed At.
 *
 * Usage: node tools/backfill-tracker-fields.mjs [--dry-run]
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBackend, isTerminal } from './tracker-backend.mjs';

const CAREER_OPS = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS_DIR = join(CAREER_OPS, 'reports');
const DRY_RUN = process.argv.includes('--dry-run');

// Build a map: report# (e.g., "001") → URL
function scanReportUrls() {
  const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'));
  const map = {};
  for (const file of files) {
    const m = file.match(/^(\d{3})-/);
    if (!m) continue;
    const reportNum = m[1];
    const content = readFileSync(join(REPORTS_DIR, file), 'utf-8');
    // Line pattern: `**URL：** <https://...>` or `**URL：** https://...`
    // Note the trailing `**` after colon (markdown bold-key). Chinese OR English colon.
    const urlMatch = content.match(/^\*\*URL[：:]\*\*\s*<?(https?:\/\/\S+?)>?(?:\s|$)/m);
    if (urlMatch) {
      let url = urlMatch[1].trim().replace(/[>）)]+$/, '');
      // Skip low-signal placeholders (bookmarklet captured but JD was login-walled)
      if (url === 'https://www.zhipin.com/' || url === 'https://www.zhipin.com') continue;
      map[reportNum] = url;
    }
  }
  return map;
}

// Extract report # from a Report cell like "[089](reports/038-...md)" → "038"
// (tracker # and report # may differ; we want the *file* number for URL lookup)
function extractReportFileNum(reportCell) {
  if (!reportCell) return null;
  // Match path reports/NNN- ... .md
  const m = reportCell.match(/reports\/(\d{3})-/);
  return m ? m[1] : null;
}

async function main() {
  const backend = await getBackend();
  console.log(`Backend: ${backend.backendName}`);
  if (DRY_RUN) console.log('(dry-run — no writes)\n');

  console.log('Scanning reports/ for URL headers...');
  const urlMap = scanReportUrls();
  console.log(`  extracted URL from ${Object.keys(urlMap).length} reports\n`);

  console.log('Fetching tracker records...');
  const apps = await backend.listApplications();
  console.log(`  got ${apps.length} records\n`);

  let urlUpdates = 0, closedUpdates = 0, skipped = 0, errors = 0;
  const errorRows = [];

  for (const app of apps) {
    const updates = {};

    // 1. URL backfill
    if (!app.url) {
      const reportFileNum = extractReportFileNum(app.report);
      if (reportFileNum && urlMap[reportFileNum]) {
        updates.url = urlMap[reportFileNum];
      }
    }

    // 2. Closed At backfill (only for terminal + missing)
    if (!app.closedAt && isTerminal(app.status)) {
      // Use existing Date as proxy (best we can do retrospectively)
      if (app.date) {
        updates.closedAt = app.date;
      }
    }

    if (Object.keys(updates).length === 0) {
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      const msg = [];
      if (updates.url) msg.push(`URL=${updates.url.slice(0, 60)}`);
      if (updates.closedAt) msg.push(`Closed At=${updates.closedAt}`);
      console.log(`  [dry] #${app.num} ${app.company.slice(0, 20)} — ${msg.join(', ')}`);
      if (updates.url) urlUpdates++;
      if (updates.closedAt) closedUpdates++;
      continue;
    }

    try {
      await backend.updateApplication(app.num, updates);
      if (updates.url) urlUpdates++;
      if (updates.closedAt) closedUpdates++;
      process.stdout.write('.');
    } catch (e) {
      errors++;
      errorRows.push({ num: app.num, err: e.message.slice(0, 100) });
      process.stdout.write('x');
    }
  }

  console.log(`\n\n=== Backfill complete ===`);
  console.log(`  ✅ URL updates:       ${urlUpdates}`);
  console.log(`  ✅ Closed At updates: ${closedUpdates}`);
  console.log(`  ⏭  unchanged rows:    ${skipped}`);
  console.log(`  ❌ errors:            ${errors}`);
  if (errorRows.length > 0) {
    console.log(`\nFirst errors:`);
    for (const e of errorRows.slice(0, 5)) {
      console.log(`  #${e.num}: ${e.err}`);
    }
  }

  if (backend.backendName === 'bitable' && !DRY_RUN && (urlUpdates + closedUpdates) > 0) {
    console.log(`\nRegenerating applications.md snapshot...`);
    const { execSync } = await import('child_process');
    execSync(`node ${join(CAREER_OPS, 'tools/sync-md-from-bitable.mjs')}`, { stdio: 'inherit' });
  }
}

main().catch(e => {
  console.error('\n❌ Backfill failed:', e.message);
  process.exit(1);
});
