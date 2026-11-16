#!/usr/bin/env node
/**
 * test-retro.mjs — regression tests for the 复盘线 (retro trigger line).
 *
 * The line answers one question: did the last two weeks of applications (old
 * enough to have had 14 days) get POSITIVE replies (HR contact / interview) at
 * a lower rate than the baseline month? Rejections are not positive — careers
 * portals auto-reject, and counting that as "a reply" hides a dead channel.
 *
 * Also pins the alert state machine: fire every day while below and
 * unresolved, never twice a day, a generated draft does NOT resolve it, a
 * completed retro does and starts a 14-day cooldown.
 *
 * Run: node tools/test-retro.mjs   (or: npm run test:retro)
 * Exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isPositive, responseKind, retroWindow, baseline, retroLine,
  listRetros, decideAlert, PLACEHOLDER,
} from './retro-core.mjs';

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n    ${e.message.split('\n').join('\n    ')}`); }
}

const T = '2026-11-16';
function shift(d, n) {
  const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
const mk = (age, extra = {}) => ({ appliedAt: `${shift(T, -age)} 00:00:00`, ...extra });
const tmp = () => mkdtempSync(join(tmpdir(), 'retro-test-'));

// ---------------------------------------------------------------- Task 1
await t('rejection is not a positive reply', () => {
  assert.equal(isPositive({ firstResponse: '拒信' }), false);
  assert.equal(isPositive({ firstResponse: 'HR沟通' }), true);
  assert.equal(isPositive({ firstResponse: '约面' }), true);
  assert.equal(isPositive({}), false);
});

await t('reaching an interview stage counts as positive, 未面 does not', () => {
  assert.equal(isPositive({ furthestStage: '一面' }), true);
  assert.equal(isPositive({ furthestStage: '未面' }), false);
  assert.equal(responseKind({ furthestStage: '二面' }), '约面');
  assert.equal(responseKind({ firstResponse: '拒信' }), '拒信');
  assert.equal(responseKind({}), '无');
});

await t('dates with time part: window holds ages 14..27 only', () => {
  const inside = [...Array(5)].map(() => mk(14)).concat([...Array(5)].map(() => mk(27)));
  const w = retroWindow([...inside, mk(13), mk(28), { appliedAt: '' }], T);
  assert.equal(w.n, 10);
  assert.equal(w.from, shift(T, -27));
  assert.equal(w.to, shift(T, -14));
});

await t('window extends back by a week until n >= 10', () => {
  const apps = [...Array(3)].map(() => mk(20)).concat([...Array(8)].map(() => mk(30)));
  const w = retroWindow(apps, T);
  assert.equal(w.n, 11);
  assert.equal(w.from, shift(T, -34));
  assert.equal(w.enough, true);
});

await t('window stops at age 55 and reports not enough', () => {
  const w = retroWindow([mk(56), mk(20)], T);
  assert.equal(w.n, 1);
  assert.equal(w.from, shift(T, -55));
  assert.equal(w.enough, false);
});

// Baseline month 2026-04 (made-up fixture): 7 positive of 25.
const aprilApps = [...Array(25)].map((_, i) => ({ appliedAt: `2026-04-${String(1 + i).padStart(2, '0')}`, ...(i < 7 ? { firstResponse: 'HR沟通' } : {}) }));

await t('baseline counts the month, positive replies only', () => {
  const b = baseline([...aprilApps, mk(20, { firstResponse: '约面' })], '2026-04', T);
  assert.equal(b.n, 25); assert.equal(b.pos, 7);
});

await t('line is below only when strictly under the baseline rate', () => {
  const low = [...Array(11)].map((_, i) => mk(20, i < 2 ? { firstResponse: 'HR沟通' } : { firstResponse: '拒信' }));
  assert.equal(retroLine([...aprilApps, ...low], { today: T, baselineMonth: '2026-04' }).status, 'below');
  // 7/25 baseline; window 7/25 exactly → not below
  const eq = [...Array(25)].map((_, i) => mk(20, i < 7 ? { firstResponse: '约面' } : {}));
  assert.equal(retroLine([...aprilApps, ...eq], { today: T, baselineMonth: '2026-04' }).status, 'ok');
  assert.equal(retroLine([...aprilApps, mk(20)], { today: T, baselineMonth: '2026-04' }).status, 'insufficient');
  assert.equal(retroLine(aprilApps, { today: T, baselineMonth: null }).status, 'no-baseline');
});

const below = { status: 'below' };
await t('first day below fires and opens a round', () => {
  const d = decideAlert({ line: below, retros: [], state: {}, today: T });
  assert.equal(d.action, 'alert'); assert.equal(d.state.active, true);
  assert.equal(d.state.firstTriggered, T); assert.equal(d.streak, 1);
});

await t('same-day rerun does not alert twice', () => {
  const d = decideAlert({ line: below, retros: [], state: { active: true, firstTriggered: T, lastSent: T }, today: T });
  assert.equal(d.action, 'already-sent');
});

await t('next day keeps alerting with streak 2', () => {
  const d = decideAlert({ line: below, retros: [], state: { active: true, firstTriggered: T, lastSent: T }, today: shift(T, 1) });
  assert.equal(d.action, 'alert'); assert.equal(d.streak, 2); assert.equal(d.state.firstTriggered, T);
});

await t('draft does not resolve the round', () => {
  const d = decideAlert({ line: below, retros: [{ date: shift(T, 1), completed: false }], state: { active: true, firstTriggered: T, lastSent: T }, today: shift(T, 2) });
  assert.equal(d.action, 'alert');
});

await t('completed retro resolves the round, then cooldown holds 14 days', () => {
  let d = decideAlert({ line: below, retros: [{ date: shift(T, 1), completed: true }], state: { active: true, firstTriggered: T }, today: shift(T, 2) });
  assert.equal(d.action, 'resolved'); assert.equal(d.state.active, false);
  d = decideAlert({ line: below, retros: [{ date: shift(T, 1), completed: true }], state: {}, today: shift(T, 14) });
  assert.equal(d.action, 'cooldown');
  d = decideAlert({ line: below, retros: [{ date: shift(T, 1), completed: true }], state: {}, today: shift(T, 15) });
  assert.equal(d.action, 'alert');
});

await t('line recovering ends the round', () => {
  const d = decideAlert({ line: { status: 'ok' }, retros: [], state: { active: true, firstTriggered: T }, today: shift(T, 1) });
  assert.equal(d.action, 'none'); assert.equal(d.state.active, false);
});

await t('listRetros: placeholder marks a draft', () => {
  const dir = tmp();
  writeFileSync(join(dir, '2026-11-16-retro.md'), '# done\n');
  writeFileSync(join(dir, '2026-11-20-retro.md'), `## 解读\n（${PLACEHOLDER}）\n`);
  writeFileSync(join(dir, 'notes.md'), 'ignored');
  assert.deepEqual(listRetros(dir).map(r => [r.date, r.completed]), [['2026-11-16', true], ['2026-11-20', false]]);
});

// ---------------------------------------------------------------- Task 2
const { runRetroCheck, renderAlert } = await import('./feishu/retro-alert.mjs');

// Baseline month: 5/10 positive. Window: 10 rows, 0 positive → below.
const belowApps = [
  ...[...Array(10)].map((_, i) => ({ appliedAt: `2026-04-${String(i + 1).padStart(2, '0')}`, ...(i < 5 ? { firstResponse: '约面' } : {}) })),
  ...[...Array(10)].map(() => mk(20)),
];
const memStateIO = () => { let s = {}; return { read: () => s, write: (x) => { s = x; } }; };
const fakeDeps = (over = {}) => {
  const calls = [];
  return {
    calls,
    deps: {
      feishuOn: true,
      baselineMonth: '2026-04',
      stateIO: memStateIO(),
      retros: [],
      sendMessage: () => { calls.push('msg'); return { messageId: 'om_x' }; },
      sendUrgent: () => { calls.push('urgent'); },
      notifyLocal: () => calls.push('local'),
      appendReminder: () => calls.push('rem'),
      ...over,
    },
  };
};

await t('alert body names the numbers and the next step', () => {
  const body = renderAlert({ window: { from: '2026-10-20', to: '2026-11-02', pos: 3, n: 30 }, base: { month: '2026-04', pos: 7, n: 25 } }, 3);
  assert.ok(body.includes('🟥 复盘线触发（第 3 天）'));
  assert.ok(body.includes('3/30 (10%)'));
  assert.ok(body.includes('7/25 (28%)'));
  assert.ok(body.includes('npm run retro'));
});

await t('happy path: message + urgent, no local fallback, lastSent recorded', async () => {
  const { calls, deps } = fakeDeps();
  const r = await runRetroCheck({ today: T, apps: belowApps, deps });
  assert.equal(r.action, 'alert');
  assert.deepEqual(calls, ['msg', 'urgent']);
  assert.equal(r.feishu, 'sent'); assert.equal(r.urgent, 'sent'); assert.equal(r.local, false);
  assert.equal(deps.stateIO.read().lastSent, T);
  assert.equal(deps.stateIO.read().messageId, 'om_x');
});

await t('urgent fails: local fallback still fires and the day is recorded', async () => {
  const { calls, deps } = fakeDeps({ sendUrgent: () => { throw new Error('99991672 missing scope im:message.urgent'); } });
  const r = await runRetroCheck({ today: T, apps: belowApps, deps });
  assert.equal(r.feishu, 'sent'); assert.equal(r.urgent, 'failed');
  assert.deepEqual(calls, ['msg', 'local', 'rem']);
  assert.equal(deps.stateIO.read().lastSent, T);
  assert.ok(r.errors.some(e => e.includes('auth scopes')), 'scope hint missing');
});

await t('same-day rerun: nothing is sent again', async () => {
  const { calls, deps } = fakeDeps();
  await runRetroCheck({ today: T, apps: belowApps, deps });
  const r = await runRetroCheck({ today: T, apps: belowApps, deps });
  assert.equal(r.action, 'already-sent');
  assert.deepEqual(calls, ['msg', 'urgent']);
});

await t('feishu switched off: local only', async () => {
  const { calls, deps } = fakeDeps({ feishuOn: false });
  const r = await runRetroCheck({ today: T, apps: belowApps, deps });
  assert.equal(r.feishu, 'skipped');
  assert.deepEqual(calls, ['local', 'rem']);
});

await t('message send fails: local fallback, no urgent attempt', async () => {
  const { calls, deps } = fakeDeps({ sendMessage: () => { throw new Error('network'); } });
  const r = await runRetroCheck({ today: T, apps: belowApps, deps });
  assert.equal(r.feishu, 'failed'); assert.equal(r.urgent, 'skipped');
  assert.deepEqual(calls, ['local', 'rem']);
});

await t('dryRun calls nothing and writes no state', async () => {
  const { calls, deps } = fakeDeps();
  const r = await runRetroCheck({ today: T, apps: belowApps, deps, dryRun: true });
  assert.equal(r.action, 'alert');
  assert.deepEqual(calls, []);
  assert.deepEqual(deps.stateIO.read(), {});
});

await t('cooldown: no alert, state closed', async () => {
  const { calls, deps } = fakeDeps({ retros: [{ date: shift(T, -3), completed: true }] });
  const r = await runRetroCheck({ today: T, apps: belowApps, deps });
  assert.equal(r.action, 'cooldown'); assert.deepEqual(calls, []);
  assert.equal(deps.stateIO.read().active, false);
});

// ---------------------------------------------------------------- Task 3
const { parseReportHeader, gateFor, direction, buildRetroReport, writeRetro } = await import('./retro.mjs');

await t('missing report file: tier and reach read as 未标注', () => {
  assert.deepEqual(parseReportHeader('—'), { tier: '未标注', reach: '未标注' });
  assert.deepEqual(parseReportHeader(''), { tier: '未标注', reach: '未标注' });
  assert.deepEqual(parseReportHeader('[1](reports/does-not-exist.md)'), { tier: '未标注', reach: '未标注' });
});

await t('report header: Tier letter and 可达性 parsed', () => {
  const root = tmp();
  mkdirSync(join(root, 'reports'));
  writeFileSync(join(root, 'reports', 'x.md'), '# 评估\n\n**Tier：** C1（不在 target_pool）\n**可达性：** 高（判据）\n**Score：** 4.0/5\n');
  assert.deepEqual(parseReportHeader('[7](reports/x.md)', root), { tier: 'C', reach: '高' });
  writeFileSync(join(root, 'reports', 'y.md'), '# 评估\n\n**Tier：** 未明确\n');
  assert.deepEqual(parseReportHeader('[8](reports/y.md)', root), { tier: '未标注', reach: '未标注' });
});

await t('gate follows the fit × Tier table', () => {
  assert.equal(gateFor('ai-app', 'A'), 3.8);
  assert.equal(gateFor('ai-app', 'C'), 4.0);
  assert.equal(gateFor('', 'B'), 3.8);                 // empty track = ai-app
  assert.equal(gateFor('auto-data', 'C'), 4.3);
  assert.equal(gateFor('ai-data-bridge', 'B'), 4.1);
  assert.equal(gateFor('ai-data-bridge', 'C'), Infinity);
  assert.equal(gateFor('ai-app', 'D'), Infinity);
  assert.equal(gateFor('auto-algo', 'A'), Infinity);
  assert.equal(gateFor('ai-app', '未标注'), 3.8);
});

await t('direction: tag wins, new rows without tag are 非数据Agent, old rows are rough-split', () => {
  assert.equal(direction({ notes: 'x；数据Agent；y', date: '2026-10-01' }), '数据Agent');
  assert.equal(direction({ notes: '', role: 'NL2SQL Agent', date: '2026-11-20' }), '非数据Agent');
  assert.equal(direction({ notes: '', role: '数据 Agent 工程师', date: '2026-10-01' }), '数据Agent（粗分）');
  assert.equal(direction({ notes: '', role: 'AI Agent 开发', date: '2026-10-01' }), '非数据Agent（粗分）');
});

const sampleApps = [
  ...belowApps.map((a, i) => ({ ...a, num: i + 1, company: `公司${i}`, role: 'AI Agent', channel: i === 0 ? '猎头' : i % 2 ? 'Boss' : '官网', track: 'ai-app', score: '4.0/5', status: 'Applied', report: '—', notes: '', date: day0(a.appliedAt) })),
  { num: 99, company: '待投', role: 'Agent', status: 'Evaluated', score: '4.2/5', track: 'ai-app', report: '—', notes: '', date: T },
];
function day0(s) { return String(s).slice(0, 10); }

await t('report skeleton: all sections, x/n (%), draft marker', () => {
  const md = buildRetroReport(sampleApps, { today: T, baselineMonth: '2026-04', trigger: 'manual', retros: [] });
  for (const h of ['## 口径', '## 1. 总量', '## 2. 分维度对比', '## 3. 清单', '## 4. 上次的待验证问题', '## 解读', '## 调整', '## 下次复盘要回答的问题']) {
    assert.ok(md.includes(h), `missing ${h}`);
  }
  assert.ok(md.includes(PLACEHOLDER), 'draft marker missing');
  assert.ok(/\d+\/\d+ \(\d+%\)/.test(md), 'no x/n (%) ratio');
  assert.ok(md.includes('#99'), 'ready queue should list the Evaluated row over the gate');
  assert.ok(md.includes('（样本小）'), 'small cells must be flagged');
});

await t('previous retro questions are carried over', () => {
  const dir = tmp();
  writeFileSync(join(dir, '2026-11-01-retro.md'), '# old\n\n## 下次复盘要回答的问题\n\n- 问题甲\n- 问题乙\n\n## 别的\n');
  const md = buildRetroReport(sampleApps, { today: T, baselineMonth: '2026-04', trigger: 'manual', retros: listRetros(dir) });
  assert.ok(md.includes('问题甲') && md.includes('问题乙'));
  assert.ok(!md.includes('## 别的'));
});

await t('refuse overwrite without --force', () => {
  const dir = tmp();
  writeRetro(`a ${PLACEHOLDER}`, { today: T, dir });
  assert.throws(() => writeRetro(`b ${PLACEHOLDER}`, { today: T, dir }), /exists|已存在/);
  assert.ok(writeRetro(`c ${PLACEHOLDER}`, { today: T, dir, force: true }).endsWith(`${T}-retro.md`));
});

// ---------------------------------------------------------------- Task 4
const { retroStatus } = await import('./retro-core.mjs');

await t('status label: active round outranks cooldown and the raw line', () => {
  const opts = { today: T, baselineMonth: '2026-04' };
  let s = retroStatus(belowApps, { ...opts, retros: [], alert: { active: true, firstTriggered: shift(T, -2) } });
  assert.equal(s.label, '🟥 触发（第 3 天）'); assert.equal(s.active, true);
  s = retroStatus(belowApps, { ...opts, retros: [{ date: shift(T, -3), completed: true }], alert: {} });
  assert.equal(s.label, `⏸ 冷却中至 ${shift(T, 11)}`);
  s = retroStatus(belowApps, { ...opts, retros: [], alert: {} });
  assert.equal(s.label, '🟥 线下（今天 9:00 检查会触发）');
  s = retroStatus(belowApps, { today: T, baselineMonth: null, retros: [], alert: {} });
  assert.equal(s.label, '⚪ 未配置基准月');
});

// ---------------------------------------------------------------- Final review fixes
await t('completed retro is never overwritten, even with --force: a -2 file is written', () => {
  const dir = tmp();
  writeFileSync(join(dir, `${T}-retro.md`), '# hand-written, completed\n');
  const p = writeRetro(`draft ${PLACEHOLDER}`, { today: T, dir, force: true });
  assert.ok(p.endsWith(`${T}-2-retro.md`), p);
  assert.equal(readFileSync(join(dir, `${T}-retro.md`), 'utf-8'), '# hand-written, completed\n');
  assert.ok(writeRetro(`d ${PLACEHOLDER}`, { today: T, dir, force: true }).endsWith(`${T}-2-retro.md`));   // -2 is a draft → force may overwrite it
});

await t('status closes the round as soon as a completed retro exists, before the next 9:00 run', () => {
  const s = retroStatus(belowApps, { today: T, baselineMonth: '2026-04', retros: [{ date: T, completed: true }], alert: { active: true, firstTriggered: shift(T, -1) } });
  assert.equal(s.active, false);
  assert.ok(s.label.startsWith('⏸'), s.label);
});

await t('Tier header variants with bold or a "Tier" prefix are parsed', () => {
  const root = tmp(); mkdirSync(join(root, 'reports'));
  writeFileSync(join(root, 'reports', 'a.md'), '**Tier：** **C**（创业）\n');
  writeFileSync(join(root, 'reports', 'b.md'), '**Tier：** Tier B2\n');
  assert.equal(parseReportHeader('[1](reports/a.md)', root).tier, 'C');
  assert.equal(parseReportHeader('[2](reports/b.md)', root).tier, 'B');
});

await t('dryRun returns the message body and the urgent-call arguments', async () => {
  const { deps } = fakeDeps();
  const r = await runRetroCheck({ today: T, apps: belowApps, deps, dryRun: true });
  assert.ok(r.body.includes('复盘线触发'));
  assert.ok(Array.isArray(r.urgentArgs) && r.urgentArgs.includes('urgent_app'), String(r.urgentArgs));
});

await t('digest and report survive an active round with the baseline month cleared', async () => {
  const { renderDigest } = await import('./feishu/notify.mjs');
  const retro = retroStatus(belowApps, { today: T, baselineMonth: null, retros: [], alert: { active: true, firstTriggered: T } });
  const md = renderDigest({ total: 0, retro, pulse: null, stale: [], ready: [], blocked: [], byDirection: {}, radar: null, baseUrl: '' });
  assert.ok(md.includes('复盘线'));
  assert.ok(!md.includes('低于基准'), 'must not claim below without a baseline');
  buildRetroReport(sampleApps, { today: T, baselineMonth: null, trigger: 'auto', retros: [] });
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
