import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBlock, readBlockById, readManifest } from '../core/blocks.mjs';
import { listPatches } from '../core/patches.mjs';
import { createSession, saveQuestions } from '../core/sessions.mjs';
import { resolveRoot, atomicWriteJson } from '../core/storage.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { computeStats } from '../core/stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');

function runCli(args) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function tmpJson(obj) {
  const f = join(mkdtempSync(join(tmpdir(), 'ib-stale-f-')), 'patch.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

function rootWithBlock() {
  const t = mkdtempSync(join(tmpdir(), 'ib-stale-'));
  runCli(['init', '--root', t]);
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.stale', revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['原始问题？'], anchors: [],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '## 30 秒版\nv1。');
  return t;
}

test('[I4] stale 后用正确 base_revision 重建同 diff → 成功（不再被去重拒绝）', () => {
  const t = rootWithBlock();
  const diff = { questions_add: ['同义问法？'] };
  // 1. 用错误 base_revision 提案 → stale
  let r = runCli(['patch', 'propose', '--file', tmpJson({
    type: 'alias_add', target_id: 'demo.stale', base_revision: 99, before_hash: null,
    proposed_diff: diff, reason: 'r', source_refs: [],
  }), '--root', t]);
  assert.equal(r.code, 2);
  assert.equal(listPatches(t).find((p) => p.status === 'stale')?.status, 'stale');
  // 2. 同 diff + 正确 base_revision 重建 → 成功 pending
  const rev = readBlockById(t, 'demo.stale').frontMatter.revision;
  r = runCli(['patch', 'propose', '--file', tmpJson({
    type: 'alias_add', target_id: 'demo.stale', base_revision: rev, before_hash: null,
    proposed_diff: diff, reason: 'r', source_refs: [],
  }), '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const { patch_id } = JSON.parse(r.out);
  // 3. 重建后的提案可以走完 approve → apply
  runCli(['patch', 'approve', patch_id, '--root', t]);
  r = runCli(['patch', 'apply', patch_id, '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  assert.ok(readBlockById(t, 'demo.stale').frontMatter.questions.includes('同义问法？'));
});

test('[I5] stats --days 按session创建时间过滤', async () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-days-'));
  runCli(['init', '--root', t]);
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.days', revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['q？'], anchors: [],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '正文');
  // 造一场「40 天前」的真实 session（直接改 session.json 的 created_at）
  const s = createSession(t, { mode: 'historical_import', source: 'craft' });
  const sf = join(t, 'sessions', s.session_id, 'session.json');
  const sess = JSON.parse(readFileSync(sf, 'utf8'));
  sess.created_at = new Date(Date.now() - 40 * 86400000).toISOString();
  writeFileSync(sf, JSON.stringify(sess, null, 2));
  // 补 questions + review 使其 eligible
  saveQuestions(t, s.session_id, [{
    question_id: 'q001', utterance_refs: ['u001'], kind: 'question', text: 'q？',
    alignment: { status: 'matched', matched_block_ids: ['demo.days'], evidence_refs: ['u001'] },
  }]);
  const { paths } = resolveRoot(t);
  mkdirSync(join(paths.reviewsDir, s.session_id), { recursive: true });
  atomicWriteJson(join(paths.reviewsDir, s.session_id, 'review.json'), {
    schema_version: 1, session_id: s.session_id, application_num: null, round: null,
    rubric_version: 'rubric-v1-2026-11-24', reviewed_at: sess.created_at,
    questions: [], summary: { top_improvements: [], needs_review: [], new_questions: [] },
  });
  const { computeStats } = await import('../core/stats.mjs');
  const all = computeStats(t, {});
  assert.equal(all.real_samples, 1);
  const recent = computeStats(t, { days: 7 });
  assert.equal(recent.real_samples, 0, '--days 7 应排除 40 天前的 session');
});

test('[I6] 冲突问题的命中计入 frequency（门槛=matched，与 needs_review 解耦）', async () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-freq-'));
  runCli(['init', '--root', t]);
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.conflict', revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['q？'], anchors: [],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '正文');
  const s = createSession(t, { mode: 'historical_import', source: 'craft' });
  saveQuestions(t, s.session_id, [{
    question_id: 'q001', utterance_refs: ['u001'], kind: 'question', text: 'q？',
    alignment: { status: 'matched', matched_block_ids: ['demo.conflict'], evidence_refs: ['u001'] },
  }]);
  const { paths } = resolveRoot(t);
  mkdirSync(join(paths.reviewsDir, s.session_id), { recursive: true });
  atomicWriteJson(join(paths.reviewsDir, s.session_id, 'review.json'), {
    schema_version: 1, session_id: s.session_id, application_num: null, round: null,
    rubric_version: 'rubric-v1-2026-11-24', reviewed_at: new Date().toISOString(),
    questions: [{
      question_id: 'q001', block_id: 'demo.conflict',
      needs_review: true, mastery_eligible: false,
      dimensions: {}, fact_conflicts: [{ fact_ref: 'x', claimed: 'c', actual: 'a' }],
      practice_action: null, new_question: null,
    }],
    summary: { top_improvements: [], needs_review: ['q001'], new_questions: [] },
  });
  const stats = computeStats(t, {});
  const c = stats.blocks.find((b) => b.block_id === 'demo.conflict');
  assert.equal(c.hits, 1, '冲突问题的命中必须计入 frequency');
  assert.equal(c.frequency, 1);
  assert.equal(c.needs_review, true);
  assert.equal(c.mastery, null, '但 mastery 仍被硬闸门压制');
});
