import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePack } from '../packs/compile.mjs';
import { renderPack, freezePack } from '../packs/render.mjs';
import { writeBlock, readBlockById } from '../core/blocks.mjs';
import { createSession, saveQuestions } from '../core/sessions.mjs';
import { resolveRoot, atomicWriteJson, atomicWriteText } from '../core/storage.mjs';
import { gatherContext } from '../packs/context.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');

function runCli(args) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function setup() {
  const t = mkdtempSync(join(tmpdir(), 'ib-render-'));
  runCli(['init', '--root', t]);
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.render', revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['渲染测试问题？'], anchors: ['锚一', '锚二'],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '## 30 秒版\n渲染正文 30 秒版内容。\n## 详细版\n详细内容。\n## 技术边界\n边界内容。');
  const reportsDir = join(t, '..', 'r-reports');
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, '901-fakeco.md'), '# 评估：虚构公司 — AI Agent工程师\n**日期：** 2026-11-24\n**Track：** ai-app\n**URL：** https://e.com/901\n\n## Block C — 公司调研\n虚构公司，天使轮。\n');
  writeFileSync(join(t, 'fixtures-tracker.json'), JSON.stringify([{ num: 901, date: '2026-11-24', company: '虚构公司', role: 'AI Agent工程师', status: 'Applied', score: '4.2/5', pdf: '✅', report: 'local:../r-reports/901-fakeco.md', notes: '', track: 'ai-app' }]));
  writeFileSync(join(t, 'fixtures-cv.md'), '# 虚构候选人\n');
  const ctx = gatherContext(t, { applicationNum: 901, round: '一面', trackerFile: join(t, 'fixtures-tracker.json'), reportsDir, cvFile: join(t, 'fixtures-cv.md') });
  return { t, ctx };
}

function gateBlock(t, blockId) {
  const s = createSession(t, { mode: 'historical_import', source: 'craft' });
  saveQuestions(t, s.session_id, [{ question_id: 'q001', utterance_refs: ['u001'], kind: 'question', text: '问？', alignment: { status: 'matched', matched_block_ids: [blockId], evidence_refs: ['u001'] } }]);
  const { paths } = resolveRoot(t);
  mkdirSync(join(paths.reviewsDir, s.session_id), { recursive: true });
  atomicWriteJson(join(paths.reviewsDir, s.session_id, 'review.json'), {
    schema_version: 1, session_id: s.session_id, application_num: null, round: null,
    rubric_version: 'rubric-v1-2026-11-24', reviewed_at: new Date().toISOString(),
    questions: [{ question_id: 'q001', block_id: blockId, needs_review: true, mastery_eligible: false, dimensions: {}, fact_conflicts: [{ fact_ref: 'x', claimed: 'c', actual: 'a' }], practice_action: null, new_question: null }],
    summary: { top_improvements: [], needs_review: ['q001'], new_questions: [] },
  });
}

test('[P2.3] render 含考前一页/知识块/公司资料/反问/准备计划', () => {
  const { t, ctx } = setup();
  const pack = compilePack(t, ctx, { prepMinutes: 60 });
  const md = renderPack(t, pack.pack_id);
  assert.match(md, /考前一页/);
  assert.match(md, /demo\.render/);
  assert.match(md, /公司资料/);
  assert.match(md, /反问/);
  assert.match(md, /准备计划/);
  assert.match(md, /渲染正文 30 秒版内容/);
});

test('[P2.3] 硬闸门块不进正文，出现在闸门段', () => {
  const { t, ctx } = setup();
  gateBlock(t, 'demo.render');
  const pack = compilePack(t, ctx, { prepMinutes: 60 });
  assert.equal(pack.selected_blocks.length, 0);
  assert.equal(pack.hard_gates.length, 1);
  const md = renderPack(t, pack.pack_id);
  assert.match(md, /硬闸门/);
  assert.match(md, /demo\.render/);
});

test('[P2.3] freeze 后：frozen、快照落盘、render 幂等且不受块编辑影响', () => {
  const { t, ctx } = setup();
  const pack = compilePack(t, ctx, { prepMinutes: 60 });
  freezePack(t, pack.pack_id);
  const pj = JSON.parse(readFileSync(join(t, 'packs', pack.pack_id, 'pack.json'), 'utf8'));
  assert.equal(pj.status, 'frozen');
  assert.ok(existsSync(join(t, 'packs', pack.pack_id, 'snapshot', 'demo.render.md')));
  const md1 = renderPack(t, pack.pack_id);
  // 冻结后篡改块文件 → render 从快照读，不变
  const blk = readBlockById(t, 'demo.render');
  atomicWriteText(blk.file, '---\n被篡改\n---\n被篡改正文');
  const md2 = renderPack(t, pack.pack_id);
  assert.equal(md1, md2);
  assert.match(md1, /渲染正文 30 秒版内容/);
});

test('[P2.3] 已冻结的同输入重编译 → 新 pack_id（不覆盖冻结包）', () => {
  const { t, ctx } = setup();
  const p1 = compilePack(t, ctx, { prepMinutes: 60 });
  freezePack(t, p1.pack_id);
  const p2 = compilePack(t, ctx, { prepMinutes: 60 });
  assert.notEqual(p2.pack_id, p1.pack_id);
  assert.equal(p2.status, 'draft');
});

test('[P2.3] CLI freeze/show', () => {
  const { t, ctx } = setup();
  const pack = compilePack(t, ctx, { prepMinutes: 60 });
  const f = runCli(['pack', 'freeze', pack.pack_id, '--root', t, '--json']);
  assert.equal(f.code, 0, f.out);
  const s = runCli(['pack', 'show', pack.pack_id, '--root', t]);
  assert.equal(s.code, 0, s.out);
  assert.match(s.out, /考前一页/);
});
