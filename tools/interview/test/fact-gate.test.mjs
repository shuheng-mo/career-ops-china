import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSeeds } from '../core/bootstrap.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');
const NOTES = join(HERE, 'fixtures', 'notes-fixture.md');
const CV_FIXTURE = join(HERE, 'fixtures', 'cv-fixture.md');

function runCli(args) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function tmpJson(obj) {
  const f = join(mkdtempSync(join(tmpdir(), 'ib-gate-f-')), 'x.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

function rootWithTechFacts(statusOfA) {
  const t = mkdtempSync(join(tmpdir(), 'ib-gate-'));
  runCli(['init', '--root', t]);
  writeFileSync(join(t, 'knowledge', 'tech-facts.yml'),
    `facts:\n  - id: tech:fact-a\n    claim: 事实A\n    status: ${statusOfA}\n  - id: tech:fact-b\n    claim: 事实B\n    status: confirmed\n`);
  return t;
}

function rootWithAnswered(t) {
  runCli(['init', '--root', t]);
  runCli(['bootstrap', '--from', 'cv', '--cv', CV_FIXTURE, '--root', t]);
  const p = JSON.parse(runCli(['dig', 'prepare', '--root', t, '--json']).out);
  const q1 = p.questions[0];
  const f = join(mkdtempSync(join(tmpdir(), 'ib-gate-dig-')), 'r.json');
  writeFileSync(f, JSON.stringify({ results: [{ seed_id: q1.seed_id, status: 'answered', raw_answer: '原话。' }] }));
  runCli(['dig', 'ingest', '--file', f, '--root', t]);
  return { t, q1 };
}

test('[I7] tech-facts 非 confirmed 状态不放行 experience 事实', () => {
  const t = rootWithTechFacts('pending');
  const { q1 } = rootWithAnswered(t);
  const drafts = [{
    seed_id: q1.seed_id,
    block_id: 'demo.gate',
    claim_kind: 'experience',
    markdown: '## 30 秒版\n声称。',
    questions: [q1.question],
    fact_refs: ['tech:fact-a'], // pending → 不得放行
  }];
  const r = runCli(['approve', '--file', tmpJson(drafts), '--root', t]);
  assert.equal(r.code, 2, `期望 exit 2，实际 ${r.code}: ${r.out.slice(0, 200)}`);
  assert.match(r.out, /未确认|confirmed|fact/);
  // confirmed 的另一个事实可以
  const ok = [{ ...drafts[0], fact_refs: ['tech:fact-b'] }];
  const r2 = runCli(['approve', '--file', tmpJson(ok), '--root', t, '--json']);
  assert.equal(r2.code, 0, r2.out);
});

test('[I7] 导入路径：candidates 的 fact_refs 只保留可核验引用（堵自我引用洞）', () => {
  const t = rootWithTechFacts('pending');
  runCli(['import', '--file', NOTES, '--root', t]);
  const candidates = [{
    source_locator: 'notes:q1',
    questions: ['Elytra 的多模型路由是怎么做的？'],
    claim_kind: 'experience',
    fact_refs: ['tech:fact-a', 'tech:fact-b', 'made-up-ref'], // fact-a pending 应剔除，made-up 剔除
    markdown: '## 30 秒版\n声称。',
  }];
  const r = runCli(['import', 'apply', '--file', tmpJson(candidates), '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const seed = listSeeds(t).find((s) => s.intent_key.startsWith('import.'));
  assert.deepEqual(seed.fact_refs, ['tech:fact-b'], `实际 ${JSON.stringify(seed.fact_refs)}`);
  // 用被剔除的引用走 approve → 拒绝（闸门闭合）
  const drafts = [{
    seed_id: seed.seed_id,
    block_id: 'demo.import-gate',
    claim_kind: 'experience',
    markdown: '## 30 秒版\n声称。',
    questions: seed.question ? [seed.question] : ['q？'],
    fact_refs: ['made-up-ref'],
  }];
  const r2 = runCli(['approve', '--file', tmpJson(drafts), '--root', t]);
  assert.equal(r2.code, 2);
});

test('[gap] historical_import session 标记 retrospective=true', async () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-gate-r-'));
  runCli(['init', '--root', t]);
  const r = runCli(['transcript', 'import', '--file', NOTES.replace('notes-fixture.md', 'transcript-fixture.md'), '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const { getSession } = await import('../core/sessions.mjs');
  const sess = getSession(t, JSON.parse(r.out).session_id);
  assert.equal(sess.retrospective, true, '历史导入必须标记 retrospective（spec §5.1.6）');
});
