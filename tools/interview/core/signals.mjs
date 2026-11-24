import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { resolveRoot, appendJsonl, readJsonlSafe, withLock } from './storage.mjs';
import { assertValid } from './validation.mjs';
import { readBlocks } from './blocks.mjs';

const SIGNAL_FIELDS = {
  signal_id: null, kind: null, source_kind: null, source_ref: null, source_hash: null,
  track: null, round: null, application_num: null, session_id: null,
  question_ref: null, block_id: null, intent_key: null, created_at: null,
};

function signalIdOf(sig) {
  return createHash('sha256')
    .update(`${sig.source_kind}|${sig.source_ref}|${sig.intent_key || ''}`)
    .digest('hex')
    .slice(0, 16);
}

function normalizeSignal(input) {
  const sig = { ...SIGNAL_FIELDS };
  for (const key of Object.keys(SIGNAL_FIELDS)) {
    if (input[key] !== undefined) sig[key] = input[key];
  }
  sig.signal_id = signalIdOf(sig);
  sig.created_at = sig.created_at || new Date().toISOString();
  assertValid('signal', sig);
  return sig;
}

export function readSignals(root) {
  const { paths } = resolveRoot(root);
  return readJsonlSafe(paths.signalsFile).rows;
}

export function appendSignal(root, input) {
  const { paths } = resolveRoot(root);
  const sig = normalizeSignal(input);
  return withLock(paths.signalsFile, () => {
    const existing = new Set(readSignals(root).map((s) => s.signal_id));
    if (existing.has(sig.signal_id)) return { deduped: true, signal_id: sig.signal_id };
    appendJsonl(paths.signalsFile, sig);
    return { deduped: false, signal_id: sig.signal_id };
  });
}

// report 头部解析：# 评估：{公司} — {岗位} / **Track：** x / **Score：** x.x/5
export function parseReportHeader(text) {
  const title = (text.match(/^# 评估：(.+)$/m) || [])[1] || '';
  const track = (text.match(/\*\*Track：\*\*\s*([a-z-]+)/) || [])[1] || null;
  const num = (text.match(/^# 评估：?(\d{3,4})[-\s]/m) || [])[1] || null;
  return { title, track, application_num: num ? Number(num) : null };
}

export function scanReports(root, reportsDir, { now = new Date().toISOString() } = {}) {
  if (!existsSync(reportsDir)) return { registered: 0, deduped: 0 };
  let registered = 0;
  let deduped = 0;
  for (const f of readdirSync(reportsDir).sort()) {
    if (!f.endsWith('.md')) continue;
    const text = readFileSync(join(reportsDir, f), 'utf8');
    const header = parseReportHeader(text);
    const r = appendSignal(root, {
      kind: 'predicted',
      source_kind: 'report_block_f',
      source_ref: f,
      source_hash: createHash('sha256').update(text).digest('hex').slice(0, 16),
      track: header.track,
      round: null,
      application_num: header.application_num,
      session_id: null,
      question_ref: null,
      block_id: null,
      intent_key: `report.${basename(f, '.md')}`,
      created_at: now,
    });
    if (r.deduped) deduped++;
    else registered++;
  }
  return { registered, deduped };
}

// CV evolve 显式增量核验：active 块的 cv:<id> 引用在账本里缺失或已 disputed/retired → review-flags
const FLAG_REASONS = { missing: '账本中不存在（可能已删除或改名）', disputed: '账本状态为 disputed', retired: '账本状态为 retired' };

export function checkCvFacts(root, ledgerPath) {
  const { paths } = resolveRoot(root);
  if (!ledgerPath || !existsSync(ledgerPath)) return { checked: 0, flagged: 0, no_ledger: true };
  const doc = YAML.parse(readFileSync(ledgerPath, 'utf8')) || {};
  const entries = Array.isArray(doc) ? doc : (doc.entries || doc.facts || []);
  const byId = new Map(entries.filter((e) => e && e.id).map((e) => [e.id, e]));
  const existingFlags = new Set(
    existsSync(join(paths.root, 'knowledge/review-flags.jsonl'))
      ? readJsonlSafe(join(paths.root, 'knowledge/review-flags.jsonl')).rows.map((r) => `${r.block_id}|${r.fact_ref}|${r.reason_kind}`)
      : []
  );
  let checked = 0;
  let flagged = 0;
  for (const block of readBlocks(root)) {
    for (const ref of block.frontMatter.fact_refs || []) {
      const m = ref.match(/^cv:(.+)$/);
      if (!m) continue;
      checked++;
      const id = m[1];
      const entry = byId.get(id);
      let reason = null;
      let reasonKind = null;
      if (!entry) {
        reason = FLAG_REASONS.missing;
        reasonKind = 'missing';
      } else if (entry.status === 'disputed') {
        reason = FLAG_REASONS.disputed;
        reasonKind = 'disputed';
      } else if (entry.status === 'retired') {
        reason = FLAG_REASONS.retired;
        reasonKind = 'retired';
      }
      if (!reason) continue;
      const key = `${block.block_id}|${ref}|${reasonKind}`;
      if (existingFlags.has(key)) continue;
      appendJsonl(join(paths.root, 'knowledge/review-flags.jsonl'), {
        block_id: block.block_id, fact_ref: ref, reason_kind: reasonKind, reason, checked_at: new Date().toISOString(),
      });
      flagged++;
    }
  }
  return { checked, flagged, no_ledger: false };
}
