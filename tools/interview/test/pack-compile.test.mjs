import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePack } from '../packs/compile.mjs';
import { gatherContext } from '../packs/context.mjs';
import { writeBlock } from '../core/blocks.mjs';
import { createSession, saveQuestions } from '../core/sessions.mjs';
import { resolveRoot, atomicWriteJson } from '../core/storage.mjs';
import { saveSeed } from '../core/bootstrap.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');

function runCli(args) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function buildCtx(t, { track = 'ai-app' } = {}) {
  const reportsDir = join(t, '..', 'pack-reports');
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, '901-fakeco.md'), [
    '# 评估：虚构公司 — AI Agent工程师',
    `**日期：** ${new Date().toISOString().slice(0, 10)}`,
    '**Track：** ai-app',
    '**URL：** https://example.com/job/901',
    '',
    '## Block C — 公司调研',
    '虚构公司，天使轮。',
  ].join('\n'));
  writeFileSync(join(t, 'fixtures-tracker.json'), JSON.stringify([
    { num: 901, date: new Date().toISOString().slice(0, 10), company: '虚构公司', role: 'AI Agent工程师', status: 'Applied', score: '4.2/5', pdf: '✅', report: 'local:../pack-reports/901-fakeco.md', notes: '', track },
  ]));
  writeFileSync(join(t, 'fixtures-cv.md'), '# 虚构候选人\n');
  return {
    applicationNum: 901,
    round: '一面',
    trackerFile: join(t, 'fixtures-tracker.json'),
    reportsDir,
    cvFile: join(t, 'fixtures-cv.md'),
  };
}

function blockFm(blockId, { criticality = 'normal', track = 'ai-app' } = {}) {
  return {
    schema_version: 1, block_id: blockId, revision: 1, kind: 'qa', status: 'active',
    tracks: [track], rounds: [], questions: [`问题 ${blockId}？`], anchors: [],
    fact_refs: [], claim_kind: 'knowledge', criticality, pinned: false, source_refs: [],
  };
}

function craftConflict(t, blockId) {
  const s = createSession(t, { mode: 'historical_import', source: 'craft' });
  saveQuestions(t, s.session_id, [{
    question_id: 'q001', utterance_refs: ['u001'], kind: 'question', text: '问？',
    alignment: { status: 'matched', matched_block_ids: [blockId], evidence_refs: ['u001'] },
  }]);
  const { paths } = resolveRoot(t);
  mkdirSync(join(paths.reviewsDir, s.session_id), { recursive: true });
  atomicWriteJson(join(paths.reviewsDir, s.session_id, 'review.json'), {
    schema_version: 1, session_id: s.session_id, application_num: null, round: null,
    rubric_version: 'rubric-v1-2026-11-24', reviewed_at: new Date().toISOString(),
    questions: [{
      question_id: 'q001', block_id: blockId, needs_review: true, mastery_eligible: false,
      dimensions: {}, fact_conflicts: [{ fact_ref: 'x', claimed: 'c', actual: 'a' }],
      practice_action: null, new_question: null,
    }],
    summary: { top_improvements: [], needs_review: ['q001'], new_questions: [] },
  });
}

test('[P2.2] 编译：selected 排除 needs_review 块（进 hard_gates），coverage_gaps ≤5', () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-compile-'));
  runCli(['init', '--root', t]);
  writeBlock(t, blockFm('demo.a', { criticality: 'normal' }), '## 30 秒版\nA 内容。');
  writeBlock(t, blockFm('demo.b', { criticality: 'high' }), '## 30 秒版\nB 内容。');
  craftConflict(t, 'demo.b');
  // 6 个 queued 种子 → coverage_gaps 截到 5
  for (let i = 0; i < 6; i++) {
    saveSeed(t, {
      seed_id: `aaaa${String(i).padStart(8, '0')}`, project_ref: null, intent_key: `q.seed${i}`,
      question: `待补问题${i}？`, aliases: [], tracks: ['ai-app'], rounds: [],
      source_refs: [], fact_refs: [], origin_kind: 'user', status: 'queued',
      missing_fields: [], answer_block_id: null, created_at: new Date().toISOString(), revision: 1,
    });
  }
  const ctx = gatherContext(t, buildCtx(t));
  const pack = compilePack(t, ctx, { prepMinutes: 60 });
  assert.equal(pack.selected_blocks.length, 1);
  assert.equal(pack.selected_blocks[0].id, 'demo.a');
  assert.equal(pack.hard_gates.length, 1);
  assert.equal(pack.hard_gates[0].id, 'demo.b');
  assert.equal(pack.coverage_gaps.length, 5);
  assert.equal(pack.status, 'draft');
  assert.equal(pack.track, 'ai-app');
  assert.ok(pack.kb_revision);
  // pack.json 落盘
  const packFile = join(t, 'packs', pack.pack_id, 'pack.json');
  assert.ok(existsSync(packFile));
  assert.deepEqual(JSON.parse(readFileSync(packFile, 'utf8')).selected_blocks, pack.selected_blocks);
});

test('[P2.2] budget 15 分钟只装得下一块（high 15 > normal 10 排序后截断）', () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-compile-2-'));
  runCli(['init', '--root', t]);
  writeBlock(t, blockFm('demo.normal', { criticality: 'normal' }), '正文');
  const ctx = gatherContext(t, buildCtx(t));
  const pack = compilePack(t, ctx, { prepMinutes: 10 });
  assert.equal(pack.selected_blocks.length, 1); // 10 分钟装 1 个 normal
  const pack2 = compilePack(t, ctx, { prepMinutes: 5 });
  assert.equal(pack2.selected_blocks.length, 0); // 5 分钟装不下任何块
  assert.ok(pack2.warnings.some((w) => /预算不足.*未覆盖/.test(w)), '预算不足要显示未覆盖块：' + JSON.stringify(pack2.warnings));
});

test('[P2.2] 确定性：同输入两次 compile → 除 pack_id/created_at 外一致', () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-compile-3-'));
  runCli(['init', '--root', t]);
  writeBlock(t, blockFm('demo.x'), '正文');
  const ctx = gatherContext(t, buildCtx(t));
  const clean = (p) => {
    const { pack_id, created_at, ...rest } = p;
    void pack_id; void created_at;
    return rest;
  };
  const p1 = clean(compilePack(t, ctx, { prepMinutes: 60 }));
  const p2 = clean(compilePack(t, ctx, { prepMinutes: 60 }));
  assert.deepEqual(p1, p2);
});

test('[P2.2] CLI pack build 端到端', () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-compile-4-'));
  runCli(['init', '--root', t]);
  writeBlock(t, blockFm('demo.cli'), '正文');
  const args = buildCtx(t);
  const r = runCli(['pack', 'build', '--application', '901', '--round', '一面', '--minutes', '60',
    '--fixtures-tracker', args.trackerFile, '--reports-dir', args.reportsDir, '--cv-file', args.cvFile,
    '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.out);
  assert.equal(j.status, 'draft');
  assert.ok(existsSync(join(t, 'packs', j.pack_id, 'pack.json')));
});

test('[P2.R] 跨 track：非命中块仍进包，track 命中块排最前；report 支持 markdown 链接', () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-pk-'));
  runCli(['init', '--root', t]);
  writeBlock(t, blockFm('demo.other-track', { track: 'ai-data-bridge' }), '## 30 秒版\n命中 track 的块。\n');
  writeBlock(t, blockFm('demo.cross-track', { track: 'ai-app' }), '## 30 秒版\n跨 track 通用块。\n');
  const ctx = buildCtx(t, { track: 'ai-data-bridge' });
  ctx.trackerFile = null;
  ctx.trackerRows = [{
    num: 901, date: new Date().toISOString().slice(0, 10), company: '虚构公司', role: 'AI工程师',
    status: 'Applied', score: '4.2/5', pdf: '✅',
    report: '[901](901-fakeco.md)', notes: '', track: 'ai-data-bridge', // 真实 md 链接格式
  }];
  const pack = compilePack(t, gatherContext(t, ctx), { prepMinutes: 60 });
  assert.equal(pack.selected_blocks.length, 2, `跨 track 块应进包：${JSON.stringify(pack.selected_blocks.map((b) => b.id))}`);
  assert.equal(pack.selected_blocks[0].id, 'demo.other-track', 'track 命中块应排第一');
  assert.ok(pack.report_source, 'markdown 链接格式的 report 应被解析');
});
