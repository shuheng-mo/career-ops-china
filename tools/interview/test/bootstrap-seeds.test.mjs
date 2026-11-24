import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCvProjects, generateSeeds } from '../core/seeds.mjs';
import { loadBootstrap, saveBootstrap } from '../core/bootstrap.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');
const CV_FIXTURE = join(HERE, 'fixtures', 'cv-fixture.md');
const REPO = join(HERE, '..', '..', '..');

function runCli(args) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function preparedRoot() {
  const t = mkdtempSync(join(tmpdir(), 'ib-bootstrap-'));
  runCli(['init', '--root', t]);
  return t;
}

const CV_TEXT = `# 李示例 — 虚构候选人

## 项目经历

### Demo Search — 虚构检索平台

虚构项目一：检索平台，性能提升 30%。

### 示例仪器

纯中文标题的虚构项目二。
`;

test('parseCvProjects 提取项目并生成稳定 slug', () => {
  const projects = parseCvProjects(CV_TEXT);
  assert.equal(projects.length, 2);
  assert.equal(projects[0].title, 'Demo Search — 虚构检索平台');
  assert.match(projects[0].slug, /^[a-z0-9][a-z0-9-]*$/);
  assert.notEqual(projects[0].slug, projects[1].slug); // 纯中文标题也有稳定 slug
});

test('generateSeeds 首批 ≤10 且 ≥5，intro 优先，schema 全过', async () => {
  const { validate } = await import('../core/validation.mjs');
  const seeds = generateSeeds(CV_TEXT, { trackIds: ['ai-app'] });
  assert.ok(seeds.length >= 5 && seeds.length <= 10, `实际 ${seeds.length}`);
  assert.equal(seeds[0].intent_key, 'intro.self');
  assert.ok(seeds.some((s) => s.intent_key.startsWith('project.')));
  for (const s of seeds) {
    assert.equal(validate('seed', s).ok, true, JSON.stringify(validate('seed', s).errors));
    assert.equal(s.origin_kind, 'template');
    assert.equal(s.status, 'queued');
    assert.match(s.intent_key, /^[a-z0-9][a-z0-9.-]*$/);
  }
  // seed_id 稳定：同输入再生成完全一致
  const again = generateSeeds(CV_TEXT, { trackIds: ['ai-app'] });
  assert.deepEqual(again.map((s) => s.seed_id), seeds.map((s) => s.seed_id));
});

test('bootstrap --from cv 幂等：同 CV 再跑种子集不变', () => {
  const t = preparedRoot();
  let r = runCli(['bootstrap', '--from', 'cv', '--cv', CV_FIXTURE, '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const first = JSON.parse(r.out);
  r = runCli(['bootstrap', '--from', 'cv', '--cv', CV_FIXTURE, '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const second = JSON.parse(r.out);
  assert.deepEqual(second.seed_ids, first.seed_ids);
  assert.equal(first.state, 'in_progress');
});

test('bootstrap status：init 后未 bootstrap → not_started', () => {
  const t = preparedRoot();
  const r = runCli(['bootstrap', 'status', '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(r.out).state, 'not_started');
});

test('paused 状态下再 bootstrap → 恢复且 seed_ids 只增不减', () => {
  const t = preparedRoot();
  runCli(['bootstrap', '--from', 'cv', '--cv', CV_FIXTURE, '--root', t, '--json']);
  const st = loadBootstrap(t);
  st.state = 'paused';
  saveBootstrap(t, st);
  const r = runCli(['bootstrap', '--from', 'cv', '--cv', CV_FIXTURE, '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.out);
  assert.equal(j.state, 'in_progress');
  const st2 = loadBootstrap(t);
  assert.ok(st2.seed_ids.length >= st.seed_ids.length);
});

test('--cv 缺省读仓库 cv.md；不存在 → exit 4 中文提示', () => {
  const t = preparedRoot();
  if (existsSync(join(t, 'cv.md'))) rmSync(join(t, 'cv.md'));
  // 仓库根的 cv.md 存在与否影响默认行为：显式指向不存在的路径必然 exit 4
  const r = runCli(['bootstrap', '--from', 'cv', '--cv', '/tmp/no-such-cv.md', '--root', t, '--json']);
  assert.equal(r.code, 4);
  assert.match(r.out, /--cv|CV/);
});

test('seed list 列出已生成种子', () => {
  const t = preparedRoot();
  runCli(['bootstrap', '--from', 'cv', '--cv', CV_FIXTURE, '--root', t]);
  const r = runCli(['seed', 'list', '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const seeds = JSON.parse(r.out).seeds;
  assert.ok(seeds.length >= 5);
});

test('--from cv 不带 --cv → 默认读仓库 cv.md（文档默认形式）', () => {
  const t = preparedRoot();
  const repoCv = join(REPO, 'cv.md');
  const r = runCli(['bootstrap', '--from', 'cv', '--root', t, '--json']);
  if (existsSync(repoCv)) {
    assert.equal(r.code, 0, `默认读仓库 cv.md 应成功，实际 ${r.code}: ${r.out.slice(0, 200)}`);
    const j = JSON.parse(r.out);
    assert.ok(j.seed_ids.length >= 5, `种子 ${j.seed_ids?.length}`);
  } else {
    // 仓库无 cv.md 的环境 → exit 4 + 中文提示
    assert.equal(r.code, 4);
    assert.match(r.out, /CV/);
  }
});
