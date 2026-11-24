import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendSignal, readSignals } from '../core/signals.mjs';
import { writeBlock } from '../core/blocks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');

function runCli(args) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function preparedRoot() {
  const t = mkdtempSync(join(tmpdir(), 'ib-signals-'));
  runCli(['init', '--root', t]);
  return t;
}

function tmpYaml(text) {
  const f = join(mkdtempSync(join(tmpdir(), 'ib-signals-c-')), 'profile.yml');
  writeFileSync(f, text);
  return f;
}

const ENABLED = tmpYaml('interview:\n  enabled: true\n');
const DISABLED = tmpYaml('interview:\n  enabled: false\n');

function writeReport(dir, name) {
  const content = [
    `# 评估：虚构公司${name} — AI Agent工程师`,
    '**Score：** 3.5/5',
    '**Track：** ai-app',
    '',
    '## Block F — 结论',
    'SKIP：虚构结论。',
  ].join('\n');
  writeFileSync(join(dir, `1350-fake${name}-2026-11-24.md`), content);
}

test('同一 report 扫两次 → 第二次全 deduped，行数不变', () => {
  const t = preparedRoot();
  const reportsDir = mkdtempSync(join(tmpdir(), 'ib-signals-r-'));
  writeReport(reportsDir, '甲');
  const args = ['signals', 'reconcile', '--scan-reports', '--reports-dir', reportsDir, '--root', t, '--config', ENABLED, '--json'];
  const r1 = JSON.parse(runCli(args).out);
  assert.equal(r1.registered, 1);
  const r2 = JSON.parse(runCli(args).out);
  assert.equal(r2.registered, 0);
  assert.equal(r2.deduped, 1);
  assert.equal(readSignals(t).length, 1);
});

test('scan-reports 两条 fixture report → 2 条 predicted 信号带 source_ref', () => {
  const t = preparedRoot();
  const reportsDir = mkdtempSync(join(tmpdir(), 'ib-signals-r2-'));
  writeReport(reportsDir, '乙');
  writeReport(reportsDir, '丙');
  const j = JSON.parse(runCli(['signals', 'reconcile', '--scan-reports', '--reports-dir', reportsDir, '--root', t, '--config', ENABLED, '--json']).out);
  assert.equal(j.registered, 2);
  const signals = readSignals(t);
  assert.ok(signals.every((s) => s.kind === 'predicted'));
  assert.ok(signals.every((s) => s.source_kind === 'report_block_f'));
  assert.ok(signals.every((s) => s.source_ref.endsWith('.md')));
});

test('enabled: false → reconcile no-op 且 exit 0', () => {
  const t = preparedRoot();
  const reportsDir = mkdtempSync(join(tmpdir(), 'ib-signals-r3-'));
  writeReport(reportsDir, '丁');
  const r = runCli(['signals', 'reconcile', '--scan-reports', '--reports-dir', reportsDir, '--root', t, '--config', DISABLED, '--json']);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.registered, 0);
  assert.equal(readSignals(t).length, 0);
});

test('手写重复 signal_id → 仍被 dedup', () => {
  const t = preparedRoot();
  const sig = {
    kind: 'predicted', source_kind: 'manual', source_ref: 'x', source_hash: null,
    track: null, round: null, application_num: null, session_id: null,
    question_ref: null, block_id: null, intent_key: 'manual.x', created_at: '2026-11-24T00:00:00Z',
  };
  const a = appendSignal(t, sig);
  const b = appendSignal(t, sig);
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, true);
  assert.equal(readSignals(t).length, 1);
});

test('--check-cv：fact_refs 引用缺失 id → review-flags 记录；无账本 → no-op', () => {
  const t = preparedRoot();
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.check-cv', revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['q'], anchors: [], fact_refs: ['cv:fake.old_id'],
    claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '正文');
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ib-signals-l-'));
  // 无账本文件 → no-op
  let r = runCli(['signals', 'reconcile', '--check-cv', '--ledger', join(ledgerDir, 'ledger.yml'), '--root', t, '--config', ENABLED, '--json']);
  assert.equal(r.code, 0);
  // 有账本但缺 id → flag
  writeFileSync(join(ledgerDir, 'ledger.yml'), 'entries:\n  - id: other.id\n    status: confirmed\n');
  r = runCli(['signals', 'reconcile', '--check-cv', '--ledger', join(ledgerDir, 'ledger.yml'), '--root', t, '--config', ENABLED, '--json']);
  const j = JSON.parse(r.out);
  assert.equal(j.flagged, 1);
  const flags = readFileSync(join(t, 'knowledge', 'review-flags.jsonl'), 'utf8').trim().split('\n');
  assert.equal(flags.length, 1);
  assert.ok(flags[0].includes('demo.check-cv'));
});
