#!/usr/bin/env node
/**
 * funnel-export.mjs — 只读求职漏斗导出（三套口径，2026-11-18 起）。
 *
 * 1. legacy 投出口径 — appliedAt 非空即分母。与 data/retro/2026-11-16-retro.md
 *    和 2026-11-18-funnel-export 的定义逐字相同，用于基线对照。此口径已冻结：
 *    新数据不再让它变化之外的东西混进来（新行 appliedAt=提交日，双写约定）。
 * 2. 接触漏斗 — contactAnchor（Contacted At，历史行 appliedAt 代理）。
 * 3. 正式投递漏斗 — Submitted At + Submission Evidence ≠ 证据待补（isConfirmedSubmission）。
 *
 * 每套口径独立分母；「流程证实但投递日期未知」单列不进比率；未满 14 天单列不判失败；
 * 分组含未知/未分类且合计守恒断言。不写任何 tracker 数据。
 *
 * Run: node tools/funnel-export.mjs [--out data/retro]     # 输出 {out}/{today}-funnel-export/
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  listApplications, trackDirection, isTerminal, TERMINAL_STATES,
  CHANNELS, INTERVIEW_STAGES, contactAnchor, isConfirmedSubmission,
} from './tracker-backend.mjs';
import { isPositive } from './retro-core.mjs';

const CAREER_OPS = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTROOT = process.argv.includes('--out')
  ? join(CAREER_OPS, process.argv[process.argv.indexOf('--out') + 1])
  : join(CAREER_OPS, 'data', 'retro');

const fmtSH = d => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(d);
const EXPORT_DATE = fmtSH(new Date());
const OUT = join(OUTROOT, `${EXPORT_DATE}-funnel-export`);
const RANGE_START = '2026-04-01';
const RESTART = '2026-10-08';
const ADJUST = '2026-11-16';

const day = s => Date.parse(`${s}T00:00:00Z`);
const addDays = (s, n) => fmtSH(new Date(day(s) + n * 86400000));
const MATURE_CUTOFF = addDays(EXPORT_DATE, -14);
const VALID_STAGES = INTERVIEW_STAGES.filter(s => s !== '未面');
const ACTIVE_STATES = new Set(['Evaluated', 'Contacted', 'Applied', 'Responded', 'Interview', 'Blocked']);
const APPLIED_IMPLYING = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Rejected']);

const csvEsc = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (headers, rows) => '﻿' + [headers.join(','), ...rows.map(r => headers.map(h => csvEsc(r[h])).join(','))].join('\n') + '\n';

function reachabilityOf(rec) {
  const m = /reports\/[^)]*?\.md/.exec(rec.report || '');
  if (!m) return '';
  const p = join(CAREER_OPS, 'reports', m[0].replace(/^reports\//, ''));
  if (!existsSync(p)) return '';
  const hit = /\*\*可达性：\*\*\s*([高中低])/.exec(readFileSync(p, 'utf-8').slice(0, 4000));
  return hit ? hit[1] : '';
}

const apps = await listApplications();

const rows = apps.map(a => {
  const appliedAt = (a.appliedAt || '').slice(0, 10);
  const contactedAt = (a.contactedAt || '').slice(0, 10);
  const submittedAt = (a.submittedAt || '').slice(0, 10);
  const cAnchor = (contactedAt || appliedAt);
  const statusImpliesApplied = APPLIED_IMPLYING.has(a.status);
  const anyResponse = !!(a.firstResponse || a.firstResponseAt);
  const reachedInterview = VALID_STAGES.includes(a.furthestStage);
  // 流程证实：面试到达或正面首复 —— 提交事实成立，但日期可能未知
  const processVerified = reachedInterview || (a.firstResponse && a.firstResponse !== '拒信');
  const sv = parseFloat(String(a.score || ''));
  const scoreValue = Number.isFinite(sv) ? sv : null;
  const scoreBucket = scoreValue === null ? '无分数'
    : scoreValue >= 4.0 ? '≥4.0' : scoreValue >= 3.5 ? '3.5-3.9' : '<3.5';
  const track = a.track || '';
  const entryDate = (a.date || '').slice(0, 10);
  const inScope = (entryDate >= RANGE_START) || appliedAt >= RANGE_START;
  return {
    ...a, appliedAt, contactedAt, submittedAt, cAnchor, statusImpliesApplied,
    anyResponse, reachedInterview, processVerified, scoreValue, scoreBucket, track, entryDate, inScope,
    // 口径归属
    inLegacy: !!appliedAt,
    inContact: !!cAnchor,
    inSubmitted: isConfirmedSubmission({ submittedAt, submissionEvidence: a.submissionEvidence }),
    submittedNoDate: processVerified && !isConfirmedSubmission({ submittedAt, submissionEvidence: a.submissionEvidence }),
    direction: trackDirection(track),
    reach: reachabilityOf(a),
    maturedLegacy: appliedAt && appliedAt <= MATURE_CUTOFF,
    maturedContact: cAnchor && cAnchor <= MATURE_CUTOFF,
    maturedSubmitted: submittedAt && submittedAt <= MATURE_CUTOFF,
    cohortKey: appliedAt || contactedAt || entryDate,
    entryMonth: entryDate ? entryDate.slice(0, 7) : '',
    isRestart: inScope && (appliedAt || contactedAt || entryDate) >= RESTART,
    isPostAdjust: inScope && (appliedAt || contactedAt || entryDate) >= ADJUST,
    active: ACTIVE_STATES.has(a.status),
    dupMarked: /DUP of #/i.test(a.notes || ''),
  };
});

const R = rows.filter(r => r.inScope);

// ---- 指标：任意口径族。sub = 进入该口径分母的行 ----
function metrics(sub, maturedField) {
  const am = sub.filter(r => r[maturedField]);
  const cnt = f => am.filter(f).length;
  const rate = (n, d) => d === 0 ? null : Math.round(n / d * 10000) / 100;
  const pos = cnt(r => isPositive(r));
  const any = cnt(r => r.anyResponse);
  const itv = cnt(r => r.reachedInterview);
  return {
    denominator: sub.length,
    immature: sub.length - am.length,
    matured: am.length,
    anyResponseMature: any,
    anyResponseRateMaturePct: rate(any, am.length),
    positiveMature: pos,
    positiveRateMaturePct: rate(pos, am.length),
    reachedInterviewMature: itv,
    interviewRateMaturePct: rate(itv, am.length),
    positiveRateMature: am.length ? `${pos}/${am.length}` : 'n/a',
    anyResponseRateMature: am.length ? `${any}/${am.length}` : 'n/a',
  };
}

function groupBy(name, keyFn, subset, maturedField) {
  const buckets = new Map();
  for (const r of subset) {
    const k = keyFn(r) || '（未知/未分类）';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const items = [...buckets.entries()].sort((x, y) => String(x[0]).localeCompare(String(y[0]), 'zh'))
    .map(([key, sub]) => ({ key, ...metrics(sub, maturedField) }));
  const sum = items.reduce((s, i) => s + i.denominator, 0);
  return { name, items, checks: { sumDenominator: sum, expected: subset.length, ok: sum === subset.length } };
}

const statusAgg = {};
for (const r of R) statusAgg[r.status] = (statusAgg[r.status] || 0) + 1;
const activeRows = R.filter(r => r.active);

const L = R.filter(r => r.inLegacy);          // legacy 分母
const C = R.filter(r => r.inContact);          // contact 分母
const S = R.filter(r => r.inSubmitted);        // submitted 分母
const SND = R.filter(r => r.submittedNoDate);  // 流程证实·日期未知

const ANCHOR_FIELD = { maturedLegacy: 'appliedAt', maturedContact: 'cAnchor', maturedSubmitted: 'submittedAt' };

// 每个口径各自的成熟字段
function funnelSection(sub, maturedField) {
  const anchor = ANCHOR_FIELD[maturedField];
  return {
    overall: metrics(sub, maturedField),
    byMonth: groupBy('月份', r => r[anchor].slice(0, 7) || null, sub, maturedField),
    byChannel: groupBy('渠道', r => r.channel || null, sub, maturedField),
    byScoreBucket: groupBy('评分区间', r => r.scoreBucket === '无分数' ? '无分数' : r.scoreBucket, sub, maturedField),
  };
}

const summary = {
  meta: {
    exportedAt: EXPORT_DATE,
    source: 'tools/tracker-backend.mjs listApplications() — tracker.backend: bitable，只读拉取',
    range: { start: RANGE_START, end: EXPORT_DATE },
    matureCutoff: MATURE_CUTOFF,
    rowCounting: {
      trackerTotal: rows.length, inScope: R.length,
      legacyDenominator: L.length, contactDenominator: C.length,
      submittedDenominator: S.length, submittedLowConfidence: S.filter(r => r.submissionEvidence === '猎头称已推荐').length,
      submittedNoDate: SND.map(r => r.num),
      appliedNoDate: R.filter(r => r.statusImpliesApplied && !r.inLegacy).map(r => r.num),
      leadsNotApplied: R.filter(r => !r.inLegacy && !r.inContact && !r.inSubmitted).length,
      dupMarked: R.filter(r => r.dupMarked).map(r => r.num),
      uniqueJobs: R.length - R.filter(r => r.dupMarked).length,
    },
    definitions: {
      legacy: 'appliedAt 非空（2026-11-18 冻结口径，与 11-16 复盘可比）',
      contact: 'contactAnchor = Contacted At || appliedAt（历史代理锚）非空',
      submitted: 'Submitted At 非空 且 Submission Evidence ≠ 证据待补（猎头称已推荐=低置信，计入且标注）',
      submittedNoDate: '流程证实（到面/笔试或正面首复）但无 Submitted At —— 单列，只计阶段不计率，不倒推日期',
      成熟样本: `各口径锚点 ≤ ${MATURE_CUTOFF}（满 14 天）`,
      正面回复: 'firstResponse ∈ {HR沟通, 约面} 或 furthestStage ∈ {笔试..Offer}（未面不算）；拒信不算',
      拒信细分: 'rejectionType：系统拒信 / 人工拒绝 / 未分类（历史空值）',
      reachability: '仅 report 头 **可达性：** 标签（2026-11-16 起）',
    },
    consistencyChecks: {},
  },
  statusAggregate: statusAgg,
  activePipeline: { count: activeRows.length, byStatus: Object.fromEntries([...new Set(activeRows.map(r => r.status))].map(s => [s, activeRows.filter(r => r.status === s).length])) },
  legacy: funnelSection(L, 'maturedLegacy'),
  contact: funnelSection(C, 'maturedContact'),
  submitted: {
    ...funnelSection(S, 'maturedSubmitted'),
    byEvidence: groupBy('提交证据', r => r.submissionEvidence || null, S, 'maturedSubmitted'),
    submittedNoDate: { nums: SND.map(r => r.num), interviewed: SND.filter(r => r.reachedInterview).length },
  },
  rejections: {
    total: R.filter(r => r.firstResponse === '拒信').length,
    系统拒信: R.filter(r => r.rejectionType === '系统拒信').length,
    人工拒绝: R.filter(r => r.rejectionType === '人工拒绝').length,
    未分类: R.filter(r => r.firstResponse === '拒信' && !r.rejectionType).length,
  },
  cohorts: {
    restartSince: RESTART, adjustSince: ADJUST,
    restart: {
      legacy: metrics(L.filter(r => r.isRestart), 'maturedLegacy'),
      contact: metrics(C.filter(r => r.isRestart), 'maturedContact'),
      submitted: metrics(S.filter(r => r.isRestart), 'maturedSubmitted'),
    },
    postAdjust: {
      legacy: metrics(L.filter(r => r.isPostAdjust), 'maturedLegacy'),
      contact: metrics(C.filter(r => r.isPostAdjust), 'maturedContact'),
      submitted: metrics(S.filter(r => r.isPostAdjust), 'maturedSubmitted'),
    },
  },
};

// 一致性断言：每口径分组合计 == 该口径分母
const checks = summary.meta.consistencyChecks;
for (const sec of ['legacy', 'contact']) {
  for (const g of ['byMonth', 'byChannel', 'byScoreBucket']) {
    const grp = summary[sec][g];
    checks[`${sec}.${g}`] = { sumDenominator: grp.checks.sumDenominator, expected: grp.checks.expected, ok: grp.checks.ok };
  }
}
for (const g of ['byMonth', 'byChannel', 'byScoreBucket', 'byEvidence']) {
  const grp = summary.submitted[g];
  checks[`submitted.${g}`] = { sumDenominator: grp.checks.sumDenominator, expected: grp.checks.expected, ok: grp.checks.ok };
}
const allOk = Object.values(checks).every(c => c.ok);
checks.allOk = allOk;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'funnel-summary.json'), JSON.stringify(summary, null, 2) + '\n');

// ---- applications-analysis.csv ----
const anaHeaders = ['num', 'inScope', 'kind', 'entryDate', 'company', 'role', 'status', 'active',
  'score', 'scoreValue', 'scoreBucket', 'track', 'direction', 'channel', 'contactedAt', 'contactType',
  'submittedAt', 'submissionEvidence', 'appliedAt', 'inLegacy', 'inContact', 'inSubmitted', 'submittedNoDate',
  'maturedLegacy', 'maturedContact', 'maturedSubmitted', 'anyResponse', 'firstResponse', 'firstResponseAt',
  'rejectionType', 'positive', 'furthestStage', 'reachedInterview', 'exitStage', 'closedAt',
  'isRestart', 'isPostAdjust', 'reachability', 'dupMarked'];
writeFileSync(join(OUT, 'applications-analysis.csv'), toCsv(anaHeaders, rows.map(r => ({
  num: r.num, inScope: r.inScope ? 'Y' : 'N',
  kind: r.inSubmitted ? 'submitted' : r.inContact ? 'contacted' : r.statusImpliesApplied ? 'applied_no_date' : 'lead',
  entryDate: r.entryDate, company: r.company, role: r.role, status: r.status, active: r.active ? 'Y' : 'N',
  score: r.score, scoreValue: r.scoreValue ?? '', scoreBucket: r.scoreBucket,
  track: r.track, direction: r.direction, channel: r.channel || '',
  contactedAt: r.contactedAt, contactType: r.contactType || '',
  submittedAt: r.submittedAt, submissionEvidence: r.submissionEvidence || '', appliedAt: r.appliedAt,
  inLegacy: r.inLegacy ? 'Y' : 'N', inContact: r.inContact ? 'Y' : 'N', inSubmitted: r.inSubmitted ? 'Y' : 'N',
  submittedNoDate: r.submittedNoDate ? 'Y' : 'N',
  maturedLegacy: r.maturedLegacy ? 'Y' : r.maturedLegacy === '' ? '' : 'N',
  maturedContact: r.maturedContact ? 'Y' : r.maturedContact === '' ? '' : 'N',
  maturedSubmitted: r.maturedSubmitted ? 'Y' : r.maturedSubmitted === '' ? '' : 'N',
  anyResponse: r.anyResponse ? 'Y' : 'N', firstResponse: r.firstResponse, firstResponseAt: (r.firstResponseAt || '').slice(0, 10),
  rejectionType: r.rejectionType || '', positive: isPositive(r) ? 'Y' : 'N',
  furthestStage: r.furthestStage, reachedInterview: r.reachedInterview ? 'Y' : 'N',
  exitStage: r.exitStage, closedAt: r.closedAt,
  isRestart: r.isRestart ? 'Y' : 'N', isPostAdjust: r.isPostAdjust ? 'Y' : 'N',
  reachability: r.reach || '未标注', dupMarked: r.dupMarked ? 'Y' : 'N',
})).sort((a, b) => a.num - b.num)));

// ---- active-pipeline.csv ----
const stateOrder = { Interview: 0, Responded: 1, Applied: 2, Contacted: 3, Blocked: 4, Evaluated: 5 };
const actHeaders = ['num', 'status', 'company', 'role', 'track', 'direction', 'channel', 'score',
  'contactedAt', 'contactType', 'submittedAt', 'submissionEvidence', 'appliedAt',
  'daysSinceAnchor', 'firstResponse', 'firstResponseAt', 'furthestStage',
  'entryDate', 'reachability', 'report', 'url', 'notes'];
writeFileSync(join(OUT, 'active-pipeline.csv'), toCsv(actHeaders, activeRows
  .map(r => ({
    num: r.num, status: r.status, company: r.company, role: r.role, track: r.track || '',
    direction: r.direction, channel: r.channel || '', score: r.score,
    contactedAt: r.contactedAt, contactType: r.contactType || '',
    submittedAt: r.submittedAt, submissionEvidence: r.submissionEvidence || '', appliedAt: r.appliedAt,
    daysSinceAnchor: r.cAnchor ? Math.floor((day(EXPORT_DATE) - day(r.cAnchor)) / 86400000) : '',
    firstResponse: r.firstResponse, firstResponseAt: (r.firstResponseAt || '').slice(0, 10),
    furthestStage: r.furthestStage, entryDate: r.entryDate, reachability: r.reach || '未标注',
    report: r.report, url: r.url, notes: r.notes,
  }))
  .sort((a, b) => (stateOrder[a.status] ?? 9) - (stateOrder[b.status] ?? 9) || String(b.appliedAt).localeCompare(String(a.appliedAt)) || b.num - a.num)));

// ---- export-notes.md（自动骨架：口径 + 总量 + 缺口）----
const fmt = m => `${m.positiveRateMature}（任意回复 ${m.anyResponseRateMature}，到面 ${m.reachedInterviewMature}/${m.matured}）`;
const notes = `# 漏斗导出 ${EXPORT_DATE}（三套口径）

- 数据源：listApplications() 只读；范围 ${RANGE_START}~${EXPORT_DATE}；成熟截止 ${MATURE_CUTOFF}（满 14 天）
- 口径定义见 funnel-summary.json meta.definitions；一致性断言 allOk=${allOk}

| 口径 | 分母 | 成熟 | 正面回复（成熟） |
|---|---|---|---|
| legacy 投出（冻结，对照 11-16 基线） | ${L.length} | ${summary.legacy.overall.matured} | ${fmt(summary.legacy.overall)} |
| 接触（contactAnchor） | ${C.length} | ${summary.contact.overall.matured} | ${fmt(summary.contact.overall)} |
| 正式投递（Submitted 确认） | ${S.length}（低置信 ${summary.meta.rowCounting.submittedLowConfidence}） | ${summary.submitted.overall.matured} | ${fmt(summary.submitted.overall)} |

- 流程证实但投递日期未知（单列不计率）：#${SND.map(r => r.num).join(' #') || '无'}
- 拒信细分：系统 ${summary.rejections.系统拒信} / 人工 ${summary.rejections.人工拒绝} / 未分类 ${summary.rejections.未分类}
- 在途 ${activeRows.length} 条：${Object.entries(summary.activePipeline.byStatus).map(([s, n]) => `${s} ${n}`).join(' / ')}
- 状态全量：${Object.entries(statusAgg).map(([s, n]) => `${s} ${n}`).join(' / ')}

重跑：node tools/funnel-export.mjs
`;
writeFileSync(join(OUT, 'export-notes.md'), notes);

console.log(JSON.stringify({
  exportDate: EXPORT_DATE, out: OUT,
  legacy: `${summary.legacy.overall.positiveRateMature}`,
  contact: `${summary.contact.overall.positiveRateMature}`,
  submitted: `${summary.submitted.overall.positiveRateMature}`,
  submittedNoDate: SND.length, allOk,
}, null, 2));
if (!allOk) process.exit(1);
