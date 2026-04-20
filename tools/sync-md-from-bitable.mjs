#!/usr/bin/env node
/**
 * sync-md-from-bitable.mjs — Regenerate data/applications.md from Bitable state.
 *
 * Used when tracker.backend = bitable. Bitable is source of truth; md is a
 * read-only snapshot regenerated on demand (or by merge-tracker after batch merges).
 *
 * Preserves the header (# Applications Tracker + table header row + ---), but
 * rewrites the entire body from Bitable records.
 *
 * Adds a frontmatter comment with the sync timestamp + Bitable URL hint.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readProfileTracker } from './tracker-backend.mjs';
import * as bitableModule from './backends/bitable-backend.mjs';

const CAREER_OPS = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');

// 11-column layout (matches md-backend.mjs formatLine):
// | # | Date | Company | Role | Score | Status | PDF | URL | Report | Notes | Closed At |
function formatLine(rec) {
  return `| ${rec.num} | ${rec.date} | ${rec.company} | ${rec.role} | ${rec.score} | ${rec.status} | ${rec.pdf} | ${rec.url || ''} | ${rec.report} | ${rec.notes} | ${rec.closedAt || ''} |`;
}

async function main() {
  const cfg = readProfileTracker();
  if (!cfg.bitable?.app_token || !cfg.bitable?.table_id_applications) {
    console.error('❌ tracker.bitable not configured. Run `npm run tracker:setup` first.');
    process.exit(1);
  }

  console.log(`Fetching records from Bitable...`);
  const bitableBackend = bitableModule.create(cfg);
  const apps = await bitableBackend.listApplications();
  console.log(`  got ${apps.length} records`);

  // Sort by num descending (matches current md ordering: newest first)
  apps.sort((a, b) => (b.num || 0) - (a.num || 0));

  const ts = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const baseUrl = cfg.bitable.base_url || '';

  const header = [
    `# Applications Tracker`,
    ``,
    `<!-- 自动生成 @ ${ts} — 源 = Bitable。手动编辑会被下次 sync 覆盖。`,
    `     编辑请去: ${baseUrl || '(未配置 base_url)'}`,
    `     手动触发 sync: npm run tracker:export -->`,
    ``,
    `| # | Date | Company | Role | Score | Status | PDF | URL | Report | Notes | Closed At |`,
    `|---|------|---------|------|-------|--------|-----|-----|--------|-------|-----------|`,
  ];

  const rows = apps.map(formatLine);
  const content = header.concat(rows).join('\n') + '\n';

  writeFileSync(APPS_FILE, content);
  console.log(`✅ Wrote ${apps.length} rows to ${APPS_FILE}`);
}

main().catch(e => {
  console.error('❌ Sync failed:', e.message);
  process.exit(1);
});
