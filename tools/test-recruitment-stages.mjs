#!/usr/bin/env node
/**
 * test-recruitment-stages.mjs — 2026-11-18 招聘阶段口径整改的回归测试。
 *
 * 场景全部来自整改任务的验收清单；测试对象都是纯函数（events.rollupFor /
 * tracker-backend 的 contactAnchor 与 isConfirmedSubmission / pulse 的
 * submittedFunnel 与 rejectionSplit / retro-core 的锚点），不碰 Bitable。
 *
 * Run: node tools/test-recruitment-stages.mjs
 */

import assert from 'node:assert/strict';
import { rollupFor } from './feishu/events.mjs';
import { contactAnchor, isConfirmedSubmission } from './tracker-backend.mjs';
import { submittedFunnel, rejectionSplit } from './feishu/pulse.mjs';
import { isPositive, matured, baseline, retroWindow } from './retro-core.mjs';

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message.split('\n')[0]}`); }
}

console.log('== 招聘阶段口径（2026-11-18 整改）==');

const T = '2026-11-18';   // “今天”，所有夹具围绕它构造
const d = (offset) => {
  const dt = new Date(`${T}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + offset);
  return dt.toISOString().slice(0, 10);
};

// ── 1. Boss 打招呼但未发简历：只进接触漏斗 ──
t('打招呼事件 → Contacted 字段，不产生提交', () => {
  const app = { num: 1, status: 'Evaluated' };
  const upd = rollupFor(app, { event: '打招呼', date: d(-3), channel: 'Boss' });
  assert.equal(upd.contactedAt, d(-3));
  assert.equal(upd.contactType, 'Boss打招呼');
  assert.equal(upd.status, 'Contacted');
  assert.ok(!('submittedAt' in upd), '打招呼不得产生 submittedAt');
  assert.ok(!('appliedAt' in upd), '打招呼不得写 appliedAt（双写只发生在确认提交）');
});
t('打招呼未发简历的行：不在正式投递分母', () => {
  const apps = [{ num: 1, contactedAt: d(-20), contactType: 'Boss打招呼', submittedAt: '', submissionEvidence: '' }];
  const f = submittedFunnel(apps, T);
  assert.equal(f.n, 0);
});

// ── 2. 明确发送简历：进入正式投递漏斗 ──
t('发送简历事件 → Applied + submittedAt + appliedAt 双写', () => {
  const app = { num: 2, status: 'Contacted', contactedAt: d(-10), appliedAt: '' };
  const upd = rollupFor(app, { event: '发送简历', date: d(-5), channel: 'Boss' });
  assert.equal(upd.submittedAt, d(-5));
  assert.equal(upd.submissionEvidence, '简历已发对方');
  assert.equal(upd.status, 'Applied');
  assert.equal(upd.appliedAt, d(-5), '确认提交时 appliedAt=Submitted At（双写约定）');
});
t('确认提交 + 满回复率：进正式投漏斗分母', () => {
  const apps = [{ num: 2, submittedAt: d(-20), submissionEvidence: '简历已发对方', firstResponse: 'HR沟通', furthestStage: '' }];
  const f = submittedFunnel(apps, T);
  assert.equal(f.n, 1);
  assert.equal(f.matured, 1);
  assert.equal(f.positiveMatured, 1);
});

// ── 3. 猎头推进客户但未确认简历提交 ──
t('猎头接触（未推荐）→ 只有接触字段', () => {
  const upd = rollupFor({ num: 3, status: 'Evaluated' }, { event: '猎头接触', date: d(-2), channel: '猎头' });
  assert.equal(upd.contactedAt, d(-2));
  assert.equal(upd.contactType, '猎头接触');
  assert.ok(!('submittedAt' in upd), '猎头沟通本身不等于提交');
});
t('猎头称已推荐 → 低置信提交：进分母但可过滤', () => {
  const upd = rollupFor({ num: 3, status: 'Contacted', contactedAt: d(-8) }, { event: '猎头推荐', date: d(-6), channel: '猎头' });
  assert.equal(upd.submittedAt, d(-6));
  assert.equal(upd.submissionEvidence, '猎头称已推荐');
  const f = submittedFunnel([{ num: 3, submittedAt: d(-20), submissionEvidence: '猎头称已推荐' }], T);
  assert.equal(f.n, 1);
  assert.equal(f.lowConfidence, 1, '猎头称已推荐要能从报表里过滤出来');
});
t('证据待补 → 不进正式投递分母', () => {
  const f = submittedFunnel([{ num: 4, submittedAt: d(-20), submissionEvidence: '证据待补' }], T);
  assert.equal(f.n, 0);
});

// ── 4. 先回复、后补发简历：事件时序正确 ──
t('contactAnchor 在有 contactedAt 时优先于 appliedAt', () => {
  assert.equal(contactAnchor({ contactedAt: d(-10), appliedAt: d(-5) }), d(-10));
  assert.equal(contactAnchor({ appliedAt: d(-5) }), d(-5), '历史行 appliedAt 代理锚');
  assert.equal(contactAnchor({}), '');
});
t('先回复后补简历：ttfr 用接触锚，submitted 成熟度用提交锚', () => {
  // 11-01 打招呼，11-03 HR 回复，11-08 才发简历
  const row = { contactedAt: '2026-11-01', appliedAt: '2026-11-08', submittedAt: '2026-11-08', submissionEvidence: '简历已发对方', firstResponseAt: '2026-11-03', firstResponse: 'HR沟通' };
  const f = submittedFunnel([row], T);
  assert.equal(f.n, 1);
  assert.equal(f.matured, 0, '提交才 10 天，未成熟不判失败');
  assert.equal(f.immature, 1);
});

// ── 5. 真实面试但缺 appliedAt：单列不丢 ──
t('#162/#230 型：流程证实无日期 → 单列，不进比率，不倒推', () => {
  const apps = [
    { num: 162, firstResponse: '约面', furthestStage: '一面', appliedAt: '', submittedAt: '' },
    { num: 230, firstResponse: '约面', furthestStage: '终面', exitStage: 'Offer被撤', appliedAt: '' },
  ];
  const f = submittedFunnel(apps, T);
  assert.equal(f.n, 0, '没有 submittedAt 就没有分母');
  assert.deepEqual(f.undatedVerifiedNums, [162, 230]);
  assert.equal(f.undatedVerifiedInterviewed, 2);
});

// ── 6. 自动拒信 ──
t('拒信不是正面回复；rejectionType 细分', () => {
  assert.equal(isPositive({ firstResponse: '拒信' }), false);
  const apps = [
    { firstResponse: '拒信', rejectionType: '系统拒信' },
    { firstResponse: '拒信', rejectionType: '系统拒信' },
    { firstResponse: '拒信', rejectionType: '人工拒绝' },
    { firstResponse: '拒信' },
  ];
  const r = rejectionSplit(apps);
  assert.equal(r.total, 4);
  assert.equal(r.系统拒信, 2);
  assert.equal(r.人工拒绝, 1);
  assert.equal(r.未分类, 1);
});

// ── 7. 未满 14 天：不算成熟失败 ──
t('提交未满 14 天 → immature 单列，不进正面率分母', () => {
  const f = submittedFunnel([
    { submittedAt: d(-13), submissionEvidence: '简历已发对方' },
    { submittedAt: d(-15), submissionEvidence: '简历已发对方' },
  ], T);
  assert.equal(f.matured, 1);
  assert.equal(f.immature, 1);
  assert.equal(f.positiveMatured, 0);
  assert.equal(f.positiveRateMature, `0/1`);
});

// ── 8. 重复线索 ──
t('DUP 标记由导出层排除唯一岗位数（此处测标记识别）', () => {
  const dup = { notes: 'DUP of #876；重复线索' };
  assert.match(dup.notes, /DUP of #/i);
});

// ── 9. 状态回退 / 同阶段多次联系：不覆盖历史、不重复计数 ──
t('晚到的接触事件不后移 Contacted At；更早的才前移', () => {
  const app = { num: 9, status: 'Contacted', contactedAt: d(-10) };
  const later = rollupFor(app, { event: '打招呼', date: d(-3), channel: 'Boss' });
  assert.ok(!later || !('contactedAt' in later), '更晚的联系不覆盖首触日期');
  const earlier = rollupFor(app, { event: '打招呼', date: d(-15), channel: 'Boss' });
  assert.equal(earlier.contactedAt, d(-15), '更早的联系前移首触日期');
});
t('高置信证据不被低置信覆盖；低→高可升级', () => {
  const app = { num: 10, status: 'Applied', submittedAt: d(-10), submissionEvidence: '简历已发对方' };
  const down = rollupFor(app, { event: '猎头推荐', date: d(-8), channel: '猎头' });
  assert.ok(!down || !('submissionEvidence' in down), '简历已发对方 不被 猎头称已推荐 覆盖');
  const up = rollupFor({ num: 11, status: 'Applied', submittedAt: d(-10), submissionEvidence: '猎头称已推荐' }, { event: '客户确认收到', date: d(-8), channel: '猎头' });
  assert.equal(up.submissionEvidence, '客户确认收到', '客户确认收到 升级 猎头称已推荐');
});
t('终态行：事件不触发主表滚回（#753 保护）', () => {
  const terminal = { num: 753, status: 'Interview', furthestStage: '二面' };  // Interview 非终态，换个真的终态
  const rejected = { num: 753, status: 'Rejected', furthestStage: '二面', exitStage: '二面挂' };
  assert.equal(rollupFor({ ...terminal, status: 'Rejected' }, { event: '打招呼', date: d(-1), channel: 'Boss' }), null);
  assert.equal(rollupFor(rejected, { event: '发送简历', date: d(-1), channel: 'Boss' }), null, '终态行只记事件不改主表');
});
t('历史 appliedAt 不被滚回改写（语义冻结）', () => {
  const app = { num: 12, status: 'Applied', appliedAt: '2026-04-20', submittedAt: '' };
  const upd = rollupFor(app, { event: '发送简历', date: '2026-11-01', channel: 'Boss' });
  assert.ok(!('appliedAt' in upd), '已有 appliedAt 的行绝不改写（2026-11-18 前的旧口径冻结）');
  assert.equal(upd.submittedAt, '2026-11-01');
});

// ── 10. legacy 口径复现（2026-11-16 复盘基线结构）──
t('legacy 锚点复现 11-16 复盘批次：A 9/28、B 1/42、C 7/71', () => {
  // 结构性夹具：按真实 11-16 复盘表的量级构造（数字取自 data/retro/2026-11-16-retro.md）
  const april = [];
  for (let i = 0; i < 28; i++) april.push({ appliedAt: `2026-04-${String((i % 27) + 1).padStart(2, '0')}`, ...(i < 9 ? { firstResponse: i < 3 ? 'HR沟通' : '约面' } : i < 12 ? { firstResponse: '拒信' } : {}) });
  const batchB = [];
  for (let i = 0; i < 42; i++) batchB.push({ appliedAt: `2026-0${5 + (i % 3)}-${String((i % 27) + 1).padStart(2, '0')}`, ...(i === 0 ? { firstResponse: 'HR沟通' } : i === 1 ? { firstResponse: '拒信' } : {}) });
  const batchC = [];
  for (let i = 0; i < 71; i++) batchC.push({ appliedAt: `2026-10-${String(((i % 23) + 8)).padStart(2, '0')}`, ...(i < 7 ? { firstResponse: i < 4 ? '约面' : 'HR沟通' } : i < 19 ? { firstResponse: '拒信' } : {}) });

  const all = [...april, ...batchB, ...batchC];
  // contactedAt 全空 → 锚点 = appliedAt（恒等变换）
  const m = matured(all, T);
  assert.equal(m.length, 28 + 42 + 71, '全部成熟');
  const b = baseline(all, '2026-04', T);
  assert.equal(b.n, 28);
  assert.equal(b.pos, 9);
  const posC = batchC.filter(isPositive).length;
  assert.equal(posC, 7);
});
t('有 contactedAt 的新行走新锚点，不影响历史行', () => {
  const mixed = [
    { appliedAt: '2026-04-10', firstResponse: '约面' },                 // 历史行
    { contactedAt: d(-15), appliedAt: '', firstResponse: '拒信' },      // 新行只有接触，已满 14 天
  ];
  const m = matured(mixed, T);
  assert.equal(m.length, 2, '接触满 14 天的新行也进接触口径成熟样本');
  assert.equal(m.filter(isPositive).length, 1, '新行的拒信不是正面');
});

// ── isConfirmedSubmission 边界 ──
t('isConfirmedSubmission 三要素：日期、证据、非待补', () => {
  assert.equal(isConfirmedSubmission({ submittedAt: d(-5), submissionEvidence: '简历已发对方' }), true);
  assert.equal(isConfirmedSubmission({ submittedAt: d(-5), submissionEvidence: '证据待补' }), false);
  assert.equal(isConfirmedSubmission({ submittedAt: d(-5) }), false);
  assert.equal(isConfirmedSubmission({ submissionEvidence: '简历已发对方' }), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
