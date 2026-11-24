import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gatherContext } from '../packs/context.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function tmpRoot({ reportDate } = {}) {
  const t = mkdtempSync(join(tmpdir(), 'ib-pack-'));
  runCliInit(t);
  // fixtures tracker：#901 有 report，#902 无 report 文件
  const reportName = `901-fakeco-${reportDate}.md`;
  mkdirSync(join(t, '..', 'reports-fixture'), { recursive: true });
  writeFileSync(join(t, 'fixtures-cv.md'), '# 虚构候选人\n\n## 项目经历\n\n### Demo 项目\n虚构内容。');
  writeFileSync(join(t, '..', 'reports-fixture', reportName), [
    '# 评估：虚构公司 — AI Agent工程师',
    `**日期：** ${reportDate}`,
    '**Track：** ai-app',
    '**Score：** 4.2/5',
    '**URL：** https://example.com/job/901',
    '',
    '## Block A — 角色摘要',
    '| Base | 苏州 |',
    '',
    '## Block C — 公司调研',
    '虚构公司为 AI Agent 创业，真格天使轮（2025-12 报道）。',
  ].join('\n'));
  writeFileSync(join(t, 'fixtures-tracker.json'), JSON.stringify([
    {
      num: 901, date: reportDate, company: '虚构公司', role: 'AI Agent工程师',
      status: 'Applied', score: '4.2/5', pdf: '✅',
      report: `local:../reports-fixture/${reportName}`, notes: '', track: 'ai-app',
    },
    {
      num: 902, date: reportDate, company: '无报告公司', role: 'AI工程师',
      status: 'Evaluated', score: '3.0/5', pdf: '❌',
      report: 'local:../reports-fixture/902-missing.md', notes: '', track: 'ai-app',
    },
  ]));
  return t;
}

function runCliInit(t) {
  execFileSync('node', [join(HERE, '..', 'cli.mjs'), 'init', '--root', t], { encoding: 'utf8' });
}

function gather(t, num, opts = {}) {
  return gatherContext(t, {
    applicationNum: num,
    round: '一面',
    trackerFile: join(t, 'fixtures-tracker.json'),
    reportsDir: join(t, '..', 'reports-fixture'),
    cvFile: join(t, 'fixtures-cv.md'),
    ...opts,
  });
}

test('[P2.1] #901：tracker 行 + report + CV hash + freshness fresh', () => {
  const today = new Date().toISOString().slice(0, 10);
  const t = tmpRoot({ reportDate: today });
  const ctx = gather(t, 901);
  assert.equal(ctx.application.num, 901);
  assert.equal(ctx.application.company, '虚构公司');
  assert.equal(ctx.report.found, true);
  assert.match(ctx.report.content, /Block C/);
  assert.equal(ctx.cv.source, 'current-cv.md');
  assert.ok(ctx.cv.hash.length >= 16);
  assert.equal(ctx.research[0].freshness, 'fresh');
  assert.ok(ctx.research[0].retrieved_at.startsWith(today));
});

test('[P2.1] report 超 30 天 → freshness expired 警示', () => {
  const old = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  const t = tmpRoot({ reportDate: old });
  const ctx = gather(t, 901);
  assert.equal(ctx.research[0].freshness, 'expired');
  assert.ok(ctx.warnings.some((w) => /过期|再查/.test(w)));
});

test('[P2.1] report 8-30 天 → stale', () => {
  const d = new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10);
  const t = tmpRoot({ reportDate: d });
  assert.equal(gather(t, 901).research[0].freshness, 'stale');
});

test('[P2.1] #902 report 文件缺失 → found:false + warning，不崩', () => {
  const today = new Date().toISOString().slice(0, 10);
  const t = tmpRoot({ reportDate: today });
  const ctx = gather(t, 902);
  assert.equal(ctx.report.found, false);
  assert.ok(ctx.warnings.some((w) => /report|报告/.test(w)));
});

test('[P2.1] tracker 缺号 → exit 4 语义（ValidationError）', () => {
  const today = new Date().toISOString().slice(0, 10);
  const t = tmpRoot({ reportDate: today });
  assert.throws(() => gather(t, 999), /不存在|未找到|999/);
});

test('[P2.1] 前轮反馈 fixtures 注入', () => {
  const today = new Date().toISOString().slice(0, 10);
  const t = tmpRoot({ reportDate: today });
  const roundsFile = join(t, 'fixtures-rounds.json');
  writeFileSync(roundsFile, JSON.stringify([
    { round: '笔试', date: '2026-11-01', result: '通过', feedback: '算法题两道' },
  ]));
  const ctx = gather(t, 901, { roundsFile });
  assert.equal(ctx.rounds_feedback.length, 1);
  assert.equal(ctx.rounds_feedback[0].result, '通过');
});
