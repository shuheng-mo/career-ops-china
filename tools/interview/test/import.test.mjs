import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');
const NOTES_FIXTURE = join(HERE, 'fixtures', 'notes-fixture.md');

function runCli(args) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function preparedRoot() {
  const t = mkdtempSync(join(tmpdir(), 'ib-import-'));
  runCli(['init', '--root', t]);
  return t;
}

function tmpJson(obj) {
  const f = join(mkdtempSync(join(tmpdir(), 'ib-import-c-')), 'candidates.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

const CANDIDATES = [
  {
    source_locator: 'notes-fixture.md:q1',
    questions: ['Elytra 的多模型路由是怎么做的？'],
    anchors: ['路由', 'DeepSeek', 'Claude'],
    claim_kind: 'knowledge',
    fact_refs: [],
    markdown: '## 30 秒版\n按查询复杂度路由到不同模型。\n## 详细版\n虚构细节。\n## 技术边界\n虚构边界。',
  },
  {
    source_locator: 'notes-fixture.md:q2',
    questions: ['示例仪器的架构是什么？'],
    anchors: ['架构'],
    claim_kind: 'knowledge',
    fact_refs: [],
    markdown: '## 30 秒版\n虚构架构答案。\n## 详细版\n虚构。\n## 技术边界\n虚构。',
  },
];

test('import 保存原件 + meta（hash），重复导入提示复用', () => {
  const t = preparedRoot();
  let r = runCli(['import', '--file', NOTES_FIXTURE, '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const j1 = JSON.parse(r.out);
  assert.equal(j1.saved, true);
  const importsDir = join(t, 'imports');
  const files = readdirSync(importsDir);
  assert.ok(files.some((f) => f.endsWith('.md')));
  assert.ok(files.some((f) => f.endsWith('.meta.json')));
  r = runCli(['import', '--file', NOTES_FIXTURE, '--root', t, '--json']);
  const j2 = JSON.parse(r.out);
  assert.equal(j2.reused, true);
  assert.equal(readdirSync(importsDir).filter((f) => f.endsWith('.md')).length, 1);
});

test('import apply → 候选进 drafts（不出现在 practice），审批激活后可见', () => {
  const t = preparedRoot();
  runCli(['import', '--file', NOTES_FIXTURE, '--root', t]);
  let r = runCli(['import', 'apply', '--file', tmpJson(CANDIDATES), '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.out);
  assert.equal(j.applied.length, 2);
  // drafts 里的候选不是 active 块
  const p1 = runCli(['practice', '--root', t]);
  assert.match(p1.out, /知识库为空|没有/);
  // 候选文件存在于 drafts
  assert.ok(readdirSync(join(t, 'knowledge', 'drafts')).some((f) => f.startsWith('import-')));
  // 审批：approve --file 同一 candidates（answer-draft schema 兼容字段）
  const drafts = CANDIDATES.map((c, i) => ({
    seed_id: j.candidates[i].seed_id,
    block_id: `demo.import-${i + 1}`,
    claim_kind: c.claim_kind,
    markdown: c.markdown,
    anchors: c.anchors,
    questions: c.questions,
    fact_refs: c.fact_refs,
  }));
  r = runCli(['approve', '--file', tmpJson(drafts), '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const p2 = runCli(['practice', '--root', t]);
  assert.match(p2.out, /Elytra|demo\.import/);
});

test('同 questions 归一化文本相同 → duplicate_of，默认不建新块', () => {
  const t = preparedRoot();
  runCli(['import', '--file', NOTES_FIXTURE, '--root', t]);
  runCli(['import', 'apply', '--file', tmpJson(CANDIDATES), '--root', t]);
  const dup = [{
    ...CANDIDATES[0],
    questions: ['Elytra的多模型路由是怎么做的？'], // 同问题不同空格/标点 → 归一化后相同
  }];
  const r = runCli(['import', 'apply', '--file', tmpJson([dup[0]]), '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.out);
  assert.equal(j.applied.length, 0);
  assert.equal(j.duplicates.length, 1);
  assert.ok(j.duplicates[0].duplicate_of);
  // 没有 seed 关联的纯导入候选：duplicate_of 指向已有候选的问题哈希记录
});
