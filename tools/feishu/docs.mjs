#!/usr/bin/env node
/**
 * docs.mjs — put the artefacts somewhere you can actually reach them.
 *
 * The gap this closes: output/ holds ~47 generated PDFs and reports/ holds 119
 * evaluation reports, all purely local. The tracker's `PDF` column is a checkbox
 * — it records that a PDF exists, not which one was sent. So "which version of my
 * CV did this company get?" is unanswerable, which is exactly the question that
 * matters the morning of an interview, usually from a phone.
 *
 * Two actions:
 *   attachCv()    — upload the sent PDF into the record's `CV PDF` attachment cell
 *   shareRecord() — generate a shareable record link (for a referrer)
 *
 * Plugin contract as elsewhere: capability off → { skipped: true }, caller treats
 * it as success. Nothing in the core flow depends on this.
 *
 * Deliberately NOT done: `drive +sync` mirroring of output/. A one-way mirror of a
 * directory that only ever grows is a cron job in search of a problem, and the
 * per-record attachment already answers the question that motivated it. The
 * reports stay as local markdown on purpose — 119 long documents belong in git,
 * not in Bitable cells.
 */

import { existsSync, statSync } from 'fs';
import { basename, isAbsolute, relative, resolve } from 'path';
import { runLarkCli, parseJsonOut, isEnabled, skipped } from './capabilities.mjs';
import { readProfileTracker } from '../tracker-backend.mjs';

const CV_FIELD = 'CV PDF';
const MAX_BYTES = 20 * 1024 * 1024;   // above this lark-cli switches to multipart; fine, but worth warning

function bitable() {
  const cfg = readProfileTracker();
  const appToken = cfg.bitable?.app_token;
  const tableId = cfg.bitable?.table_id_applications;
  if (!appToken || !tableId) throw new Error('tracker.bitable 未配置（app_token / table_id_applications）');
  return { appToken, tableId };
}

/**
 * Business num → record_id for the whole table, from ONE listing.
 *
 * The listing is the slow part (the table is >1000 rows, ~12 paged lark-cli
 * calls); the upload itself is quick. Attaching 13 CVs one invocation at a time
 * re-listed the table 13 times (~45 s each). attachMany() builds this once.
 */
export async function buildRecordIndex() {
  const mod = await import('../backends/bitable-backend.mjs');
  const backend = mod.create(readProfileTracker());
  const index = new Map();
  for (const a of await backend.listApplications()) {
    if (a.num && a._recordId) index.set(Number(a.num), a._recordId);
  }
  return index;
}

function lookup(index, num) {
  const id = index.get(Number(num));
  if (!id) throw new Error(`tracker 里没有 #${num}（或该行没有 record_id）`);
  return id;
}

async function recordIdFor(num) {
  return lookup(await buildRecordIndex(), num);
}

/**
 * Attach the PDF that was actually sent to this application.
 *
 * `--file` takes a local path. lark-cli rejects paths outside the working
 * directory for some commands, so this resolves and reports clearly rather than
 * letting a confusing CLI error surface.
 */
export async function attachCv({ num, pdfPath, dryRun = false, recordIndex = null }) {
  if (!isEnabled('docs')) return skipped('docs', `would have attached ${pdfPath}`);

  const abs = resolve(pdfPath);
  if (!existsSync(abs)) return { ok: false, num, error: `找不到文件：${abs}` };
  const size = statSync(abs).size;
  if (size === 0) return { ok: false, num, error: `文件是空的：${abs}` };

  const { appToken, tableId } = bitable();
  let recordId;
  try {
    recordId = recordIndex ? lookup(recordIndex, num) : await recordIdFor(num);
  } catch (e) {
    return { ok: false, num, error: e.message };
  }

  // Pass a cwd-relative path when possible: several lark-cli upload paths reject
  // absolute paths or anything that escapes the working directory.
  const rel = relative(process.cwd(), abs);
  const filePath = !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;

  const args = [
    'base', '+record-upload-attachment',
    '--base-token', appToken,
    '--table-id', tableId,
    '--record-id', recordId,
    '--field-id', CV_FIELD,
    '--file', filePath,
  ];
  if (dryRun) args.push('--dry-run');

  try {
    const out = runLarkCli(args, { write: true, timeoutMs: 120000 });   // uploads are slow
    return {
      ok: true, skipped: false, dryRun, num, recordId,
      file: basename(abs), bytes: size,
      multipart: size > MAX_BYTES,
      data: parseJsonOut(out)?.data ?? null,
      raw: dryRun ? out : undefined,
    };
  } catch (e) {
    return { ok: false, num, error: e.message };
  }
}

/**
 * Attach several CVs with one table listing.
 *
 * Every file is checked before the listing, so a typo'd path fails in a second
 * instead of after the slow read. One failed upload does not stop the rest.
 *
 * @param pairs  [{num, pdfPath}]
 * @returns      one attachCv() result per pair, in order
 */
export async function attachMany(pairs, { dryRun = false } = {}) {
  if (!isEnabled('docs')) return pairs.map(p => skipped('docs', `would have attached ${p.pdfPath}`));
  const missing = pairs.filter(p => !existsSync(resolve(p.pdfPath)));
  if (missing.length) {
    return pairs.map(p => missing.includes(p)
      ? { ok: false, num: p.num, error: `找不到文件：${resolve(p.pdfPath)}` }
      : { ok: false, num: p.num, error: '未上传：同批有文件路径错误，先修正再重跑' });
  }
  const recordIndex = await buildRecordIndex();
  const results = [];
  for (const p of pairs) results.push(await attachCv({ ...p, dryRun, recordIndex }));
  return results;
}

/**
 * A clickable link to one record, for handing to a referrer.
 *
 * Note this shares a tracker row — company, role, score, and your notes about
 * them. Never generate one for a third party without the user deciding to.
 */
export async function shareRecord({ num, dryRun = false }) {
  if (!isEnabled('docs')) return skipped('docs');
  const { appToken, tableId } = bitable();
  let recordId;
  try {
    recordId = await recordIdFor(num);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const args = [
    'base', '+record-share-link-create',
    '--base-token', appToken, '--table-id', tableId, '--record-id', recordId,
  ];
  if (dryRun) args.push('--dry-run');
  try {
    const out = runLarkCli(args, { write: true });
    return { ok: true, skipped: false, dryRun, num, data: parseJsonOut(out)?.data ?? null, raw: dryRun ? out : undefined };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// CLI entry: node tools/feishu/docs.mjs <num> <pdf> [<num> <pdf> ...] [--dry-run]
// Pass every pair in one call — the table is listed once for all of them.
if (process.argv[1] && process.argv[1].endsWith('docs.mjs')) {
  const pos = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (pos.length === 0 || pos.length % 2 !== 0 || pos.some((a, i) => i % 2 === 0 && !/^\d+$/.test(a))) {
    console.error('用法: node tools/feishu/docs.mjs <tracker #> <pdf 路径> [<tracker #> <pdf 路径> ...] [--dry-run]');
    process.exit(1);
  }
  const pairs = [];
  for (let i = 0; i < pos.length; i += 2) pairs.push({ num: pos[i], pdfPath: pos[i + 1] });
  const results = await attachMany(pairs, { dryRun: process.argv.includes('--dry-run') });
  let failed = 0;
  for (const res of results) {
    if (res.skipped) console.log(`⏭  ${res.reason}`);
    else if (!res.ok) { console.error(`❌ #${res.num}: ${res.error}`); failed++; }
    else console.log(`✅ #${res.num} ← ${res.file} (${(res.bytes / 1024).toFixed(0)} KB)${res.dryRun ? ' [dry-run]' : ''}`);
  }
  if (failed) process.exit(1);
}
