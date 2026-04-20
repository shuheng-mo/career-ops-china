#!/usr/bin/env node
/**
 * migrate-tracker-md-to-bitable.mjs — One-shot: data/applications.md → Bitable.
 *
 * Idempotent: uses findByCompanyRole to skip already-migrated rows.
 * Safe to re-run after a partial failure.
 */

import { readProfileTracker } from './tracker-backend.mjs';
import * as mdModule from './backends/md-backend.mjs';
import * as bitableModule from './backends/bitable-backend.mjs';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const cfg = readProfileTracker();

  if (!cfg.bitable?.app_token || !cfg.bitable?.table_id_applications) {
    console.error('❌ tracker.bitable not configured in profile.yml.');
    console.error('   Run `npm run tracker:setup` first.');
    process.exit(1);
  }

  console.log(`Source: data/applications.md (md backend)`);
  console.log(`Target: Bitable app=${cfg.bitable.app_token} table=${cfg.bitable.table_id_applications}\n`);

  const mdBackend = mdModule.create({});
  const bitableBackend = bitableModule.create(cfg);

  const mdApps = await mdBackend.listApplications();
  console.log(`Found ${mdApps.length} rows in applications.md to migrate\n`);

  // Pre-fetch Bitable state for O(N) dedup vs O(N²) per-add lookups
  const bitableApps = await bitableBackend.listApplications();
  const bitableKeys = new Set(
    bitableApps.map(a => `${normalize(a.company)}|${normalize(a.role)}`)
  );

  let migrated = 0, skipped = 0, failed = 0;
  const failures = [];

  for (let i = 0; i < mdApps.length; i++) {
    const app = mdApps[i];
    const key = `${normalize(app.company)}|${normalize(app.role)}`;

    if (bitableKeys.has(key)) {
      skipped++;
      continue;
    }

    try {
      const result = await bitableBackend.addApplication(app);
      if (result.inserted) {
        migrated++;
        process.stdout.write('.');
      } else {
        skipped++;
      }
      bitableKeys.add(key);
    } catch (e) {
      failed++;
      failures.push({ num: app.num, company: app.company, role: app.role, error: e.message });
      process.stdout.write('x');
    }

    // Rate-limit: sleep every 10 records (lark API docs suggest ~5 req/s)
    if ((i + 1) % 10 === 0) await sleep(500);
  }

  console.log(`\n\n=== Migration complete ===`);
  console.log(`  ✅ migrated: ${migrated}`);
  console.log(`  ⏭  skipped (already in Bitable): ${skipped}`);
  console.log(`  ❌ failed: ${failed}`);

  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures.slice(0, 10)) {
      console.log(`  #${f.num} ${f.company} — ${f.role}: ${f.error.slice(0, 100)}`);
    }
    if (failures.length > 10) console.log(`  ... and ${failures.length - 10} more`);
    process.exit(1);
  }

  console.log(`\nNext: edit config/profile.yml → tracker.backend: bitable to switch active backend.`);
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/\s+/g, '');
}

main().catch(e => {
  console.error('\n❌ Migration error:', e.message);
  process.exit(1);
});
