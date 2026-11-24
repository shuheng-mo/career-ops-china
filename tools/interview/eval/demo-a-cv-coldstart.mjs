#!/usr/bin/env node
// Demo A — CV-only 冷启动（spec §12 P1.6）：仅虚构 CV、无逐字稿、无历史、无 API Key
// 断言：≥1 个 approved 块 + practice 题单非空 + predicted 信号存在且 real_samples=0
//       + 重复 bootstrap 幂等（合并去重）
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const CLI = join(REPO, 'tools', 'interview', 'cli.mjs');
const CV = join(REPO, 'tools', 'interview', 'test', 'fixtures', 'cv-fixture.md');

function cli(args, { expectFail = false } = {}) {
  try {
    return JSON.parse(execFileSync('node', [CLI, ...args], { encoding: 'utf8' }));
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    if (expectFail) return { ok: false, message: out };
    console.error('CLI 失败：', args.join(' '), '\n', out);
    process.exit(1);
  }
}

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`❌ Demo A 断言失败：${msg}`);
    process.exit(1);
  }
};

const root = mkdtempSync(join(tmpdir(), 'ib-demo-a-'));
const step = (m) => console.log(`  ${m}`);

// 1. init + bootstrap（CV 冷启动）
step('1. init + bootstrap --from cv');
cli(['init', '--root', root, '--json']);
const boot1 = cli(['bootstrap', '--from', 'cv', '--cv', CV, '--root', root, '--json']);
assert(boot1.state === 'in_progress', 'bootstrap state');
assert(boot1.seed_ids.length >= 5 && boot1.seed_ids.length <= 10, `首批种子 5-10 个，实际 ${boot1.seed_ids.length}`);

// 2. 重复 bootstrap 幂等（合并去重）
step('2. 重复 bootstrap 幂等');
const boot2 = cli(['bootstrap', '--from', 'cv', '--cv', CV, '--root', root, '--json']);
assert(JSON.stringify(boot2.seed_ids) === JSON.stringify(boot1.seed_ids), '重复 bootstrap 种子集不变');

// 3. dig：答一题、跳过一题
step('3. dig prepare + ingest（答 intro，跳过下一题）');
const prep = cli(['dig', 'prepare', '--root', root, '--json']);
assert(prep.questions.length >= 1, 'dig prepare 出题');
const intro = prep.questions.find((q) => q.intent_key === 'intro.self');
const second = prep.questions.find((q) => q.seed_id !== intro.seed_id);
const digResult = join(mkdtempSync(join(tmpdir(), 'ib-demo-a-dig-')), 'result.json');
writeFileSync(digResult, JSON.stringify({
  results: [
    { seed_id: intro.seed_id, status: 'answered', raw_answer: '我是虚构候选人李示例，做过 Demo Search 虚构检索平台，负责 NL2SQL 链路。' },
    { seed_id: second.seed_id, status: 'skipped' },
  ],
}));
cli(['dig', 'ingest', '--file', digResult, '--root', root, '--json']);

// 4. agent 起草 + 人工 approve（事实受约束：knowledge 类，无未确认事实）
step('4. drafts export → 起草 → approve');
const task = cli(['drafts', 'export', '--root', root, '--json']);
assert(task.seeds.length === 1, 'drafts export 含 answered 种子');
const drafts = [{
  seed_id: intro.seed_id,
  block_id: 'demo.intro-self',
  claim_kind: 'knowledge',
  markdown: '## 30 秒版\n我是李示例，虚构候选人，专注 NL2SQL 链路。\n## 详细版\n（基于原话的虚构展开）\n## 技术边界\n行级数据脱敏没做。',
  anchors: ['NL2SQL', '虚构平台'],
  questions: [intro.question],
  fact_refs: [],
}];
const draftsFile = join(mkdtempSync(join(tmpdir(), 'ib-demo-a-ap-')), 'drafts.json');
writeFileSync(draftsFile, JSON.stringify(drafts));
const approved = cli(['approve', '--file', draftsFile, '--root', root, '--json']);
assert(approved.applied.length === 1, 'approve 激活 1 块');

// 5. practice 题单非空
step('5. practice 题单');
const practice = execFileSync('node', [CLI, 'practice', '--root', root], { encoding: 'utf8' });
assert(practice.includes('30 秒版'), 'practice 含 30 秒版');

// 6. JD/Block F 增量信号（fixture report 扫描）+ 统计隔离
step('6. signals reconcile（predicted）+ stats 隔离');
const reportsDir = join(root, '_fixture-reports');
mkdirSync(reportsDir, { recursive: true });
writeFileSync(join(reportsDir, '1399-fakeco-2026-11-24.md'), '# 评估：虚构公司 — AI Agent工程师\n**Score：** 3.5/5\n**Track：** ai-app\n\n## Block F — 结论\nSKIP。');
const cfg = join(root, '_enabled-profile.yml');
writeFileSync(cfg, 'interview:\n  enabled: true\n');
const sig = cli(['signals', 'reconcile', '--scan-reports', '--reports-dir', reportsDir, '--root', root, '--config', cfg, '--json']);
assert(sig.registered === 1, 'report 信号登记 1 条');
const stats = cli(['stats', '--root', root, '--json']);
assert(stats.real_samples === 0, `real_samples=0（预测不污染热度），实际 ${stats.real_samples}`);
assert(stats.blocks[0]?.frequency === null, '无真实样本时 frequency=null');

console.log('✅ Demo A 通过：CV 冷启动 → 种子 → 深挖 → 审批 → 题单 → JD 增量信号（真实热度保持 null）');
