#!/usr/bin/env node
/**
 * audit-recruitment-stages.mjs — 历史数据审计与回填（默认 dry-run，只读）。
 *
 * 逐行核对 tracker 里的投递/接触事件，为 2026-11-18 口径整改（Contacted vs
 * Submitted）产出可追溯的回填建议。产物：
 *   data/retro/{date}-stage-audit.json  — 机器可读建议
 *   data/retro/{date}-stage-audit.md    — 人读版（可确定迁移 / 需人工确认 / 无法修复）
 *
 * 铁律（写死在规则里，不是注释）：
 *   - 只建议填「当前为空」的字段，永不改已有值，永不降级 Status，永不回改历史
 *   - 以下信息**不得**单独作为「正式投递已发生」的证据：
 *     Status=Applied 本身 / HR 联系方式 / JD 可读 / 猎头沟通记录 /
 *     notes 里的模糊词（推荐、沟通中、已联系、已联系HR）
 *   - 进入面试不倒推投递日期：#162/#212/#230 类行只认定「提交事实成立」，
 *     submittedAt 留空（正式投递漏斗里单列，不计率）
 *   - DUP 标记行与已推进到面试的在途行（如 #753）只读不动
 *
 * 执行：node tools/audit-recruitment-stages.mjs                     # dry-run（默认）
 *       node tools/audit-recruitment-stages.mjs --apply \
 *            --confirm-file <json>                                  # 仅应用 confirm 文件中
 *                                                                    # confirmed:true 的行
 *                                                                    # （高置信 auto 桶也须逐行确认）
 * 回滚：--apply 同时写 {date}-stage-audit-rollback.json（逆操作）。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  listApplications, updateMany, INTERVIEW_STAGES,
} from './tracker-backend.mjs';

const CAREER_OPS = join(dirname(fileURLToPath(import.meta.url)), '..');
const RETRO = join(CAREER_OPS, 'data', 'retro');
const fmtSH = d => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(d);
const TODAY = fmtSH(new Date());

const VALID_STAGES = INTERVIEW_STAGES.filter(s => s !== '未面');
const stageAtLeast笔试 = a => VALID_STAGES.includes(a.furthestStage);
const processVerified = a => stageAtLeast笔试(a) || (!!a.firstResponse && a.firstResponse !== '拒信');

// 可追溯的明文证据（用户/评估报告写的，不是脚本猜的）。
// 必须出现「简历」——「已联系 / 沟通中 / 推荐给」这类模糊词永远不满足这个正则，
// 也就是说模糊词单独出现时绝不判正式投递（排除规则编码在正则本身）。
const NOTES_RESUME_SENT = /(已(经)?(发送|发过|投递)(了)?简历|简历已发(送)?|发送简历|已发简历)/;

const CONTACT_TYPE_BY_CHANNEL = {
  Boss: 'Boss打招呼', 猎头: '猎头接触', 官网: '官网留言', 内推: '内推请求', LinkedIn: '其他', 猎聘: '其他', 其他: '其他',
};

/**
 * 对一行产出建议。返回 null = 无需处理。
 * proposal: { fields: {只含当前为空的字段}, confidence, reason, evidence, needsConfirm }
 */
function auditRow(a) {
  const appliedAt = (a.appliedAt || '').slice(0, 10);
  const empty = k => !a[k];

  // 1) 已有 Submitted At —— 整改已生效，跳过
  if (a.submittedAt) return null;

  const P = (fields, confidence, evidence, needsConfirm, reason) =>
    (Object.keys(fields).length ? { num: a.num, company: a.company, role: a.role, fields, confidence, evidence, needsConfirm, reason } : null);

  // 2) 有 appliedAt 的行 —— 按证据强度分流
  if (appliedAt) {
    // 2a. 流程已推进到笔试/面试 → 提交事实由流程本身证实（日期继承已记录的 appliedAt，不是倒推）
    if (stageAtLeast笔试(a)) {
      return P(pickEmpty(a, { submittedAt: appliedAt, submissionEvidence: '流程已推进佐证' }),
        '高', `furthestStage=${a.furthestStage}（流程消费过投递）`, false,
      '到达笔试/面试 ⇒ 提交事实成立；submittedAt=已记录的 appliedAt（继承，非倒推）');
    }
    // 2b. notes 有明文「发送简历」类记录（NOTES_RESUME_SENT 要求出现「简历」类明文，
    //     模糊词「沟通中/已联系/推荐」单独出现不满足它 —— 排除规则编码在正则里）
    if (NOTES_RESUME_SENT.test(a.notes || '')) {
      return P(pickEmpty(a, { submittedAt: appliedAt, submissionEvidence: '简历已发对方' }),
        '高', `notes 明文：${(a.notes.match(NOTES_RESUME_SENT) || [''])[0]}`, false,
      'notes 是用户/评估写入的可追溯记录');
    }
    // 2c. 官网 / LinkedIn —— 走系统申请通道，投递即系统提交
    if (a.channel === '官网' || a.channel === 'LinkedIn') {
      return P(pickEmpty(a, { submittedAt: appliedAt, submissionEvidence: '系统提交确认' }),
        '高', `channel=${a.channel}（系统申请通道）`, false,
      '官网/LinkedIn 投递动作本身就是系统提交');
    }
    // 2d. 猎头 —— 只能证明简历给了猎头；「客户方已收到」未确认
    if (a.channel === '猎头') {
      return P(pickEmpty(a, { submittedAt: appliedAt, submissionEvidence: '猎头称已推荐', contactedAt: appliedAt, contactType: '猎头接触' }),
        '中', `channel=猎头；无客户方确认记录`, true,
      '猎头渠道：低置信提交（计入正式漏斗但可过滤）；客户方确认后改 evidence=客户确认收到');
    }
    // 2e. Boss / 猎聘 / 其他 / 内推 / 未记录 —— appliedAt 大概率是打招呼时间
    const ct = CONTACT_TYPE_BY_CHANNEL[a.channel] || '其他';
    return P(pickEmpty(a, { contactedAt: appliedAt, contactType: ct, submissionEvidence: '证据待补' }),
      '中', `channel=${a.channel || '未记录'}；无简历发送记录`, true,
      '按接触事件归类；提交事实待确认（若确认已发简历：submittedAt=日期 + evidence=简历已发对方）');
  }

  // 3) 无 appliedAt 但流程已证实（#162/#212/#230）—— 事实成立、日期未知，绝不倒推
  if (processVerified(a)) {
    const fields = pickEmpty(a, { contactType: a.channel ? (CONTACT_TYPE_BY_CHANNEL[a.channel] || '其他') : null });
    if (!Object.keys(fields).length) return null;   // 已无可填字段 —— 单列状态由漏斗导出呈现
    return {
      num: a.num, company: a.company, role: a.role,
      fields, confidence: '高', needsConfirm: true,
      evidence: `furthestStage=${a.furthestStage || '—'}，firstResponse=${a.firstResponse || '—'}`,
      reason: '提交事实成立（流程已推进），但投递日期未知 —— submittedAt 留空，正式漏斗单列不计率；记得日期请人工补',
    };
  }
  return null;
}

// 只保留当前为空的字段（永不改已有值）
function pickEmpty(a, fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v && !a[k]) out[k] = v;
  }
  return out;
}

// ---- main ----
const APPLY = process.argv.includes('--apply');
const confirmFile = process.argv.includes('--confirm-file')
  ? process.argv[process.argv.indexOf('--confirm-file') + 1] : null;

const apps = await listApplications();
const dupMarked = apps.filter(a => /DUP of #/i.test(a.notes || ''));

const proposals = [];
const readOnlyFlags = [];
for (const a of apps) {
  // 只读不动：DUP 行；已有 furthestStage 的在途行也只会收到「填空」建议（规则保证）
  const p = auditRow(a);
  if (p) proposals.push(p);
  if (!a.firstResponseAt && a.firstResponse) readOnlyFlags.push({ num: a.num, kind: 'firstResponseAt 缺失（回复时延无法计算）', firstResponse: a.firstResponse });
  // 流程证实但无确认提交（日期未知或证据待补）—— 永久单列，只由漏斗导出呈现
  if (processVerified(a) && !a.submittedAt) readOnlyFlags.push({ num: a.num, kind: '流程证实·提交未确认（单列不计率）' });
}

const auto = proposals.filter(p => !p.needsConfirm);
const needConfirm = proposals.filter(p => p.needsConfirm);
// 无法修复 = 需人工确认里日期永久未知的（无 appliedAt 的流程证实行）
const unfixableDates = needConfirm.filter(p => !p.fields?.submittedAt && !apps.find(x => x.num === p.num)?.appliedAt);

const buckets = {
  可确定迁移: auto,
  需人工确认: needConfirm,
  无法修复_日期永久未知: unfixableDates.map(p => p.num),
  只读不改: {
    dupMarked: dupMarked.map(a => a.num),
    firstResponseMissingDate: readOnlyFlags.map(r => r.num),
  },
  counts: { audited: proposals.length, auto: auto.length, needConfirm: needConfirm.length, dup: dupMarked.length },
};

mkdirSync(RETRO, { recursive: true });
const jsonPath = join(RETRO, `${TODAY}-stage-audit.json`);
writeFileSync(jsonPath, JSON.stringify({ date: TODAY, buckets, proposals }, null, 2) + '\n');

// ---- md 报告 ----
const L = [];
L.push(`# 招聘阶段审计 ${TODAY}（dry-run${APPLY ? ' → APPLY' : ''}）`, '');
L.push(`> 审计 ${apps.length} 行；产出建议 ${proposals.length} 条（可自动 ${auto.length} / 需人工确认 ${needConfirm.length}）。`);
L.push(`> 铁律：只填空字段、不改已有值、不降级、进面试不倒推日期。DUP 行与回复日期缺失行只读不动。`, '');
L.push('## 可确定迁移（高置信，可追溯）', '');
L.push('| # | 公司 | 建议字段 | 证据 | 说明 |');
L.push('|---|------|---------|------|------|');
for (const p of auto) L.push(`| ${p.num} | ${p.company} | ${JSON.stringify(p.fields)} | ${p.evidence} | ${p.reason} |`);
L.push('', '## 需人工确认', '');
L.push('| # | 公司 | 建议字段 | 置信 | 证据 | 说明 |');
L.push('|---|------|---------|------|------|------|');
for (const p of needConfirm) L.push(`| ${p.num} | ${p.company} | ${JSON.stringify(p.fields)} | ${p.confidence} | ${p.evidence} | ${p.reason} |`);
if (unfixableDates.length) {
  L.push('', `**日期永久未知（不倒推，正式漏斗单列）：** #${unfixableDates.map(p => (typeof p === 'object' ? p.num : p)).join(' #')}`);
}
L.push('', '## 只读不改', '');
L.push(`- DUP 标记（唯一岗位统计排除）：#${dupMarked.map(a => a.num).join(' #') || '无'}`);
L.push(`- firstResponse 有值但无日期：#${readOnlyFlags.filter(r => r.kind.includes('firstResponseAt')).map(r => r.num).join(' #') || '无'}`);
L.push(`- 流程证实但提交未确认（正式漏斗单列不计率）：#${readOnlyFlags.filter(r => r.kind.includes('提交未确认')).map(r => r.num).join(' #') || '无'}`);
L.push('', '## 执行', '');
L.push('确认后在 JSON 里把目标行改 `"confirmed": true`，然后：');
L.push('```');
L.push(`node tools/audit-recruitment-stages.mjs --apply --confirm-file ${jsonPath}`);
L.push('```');
writeFileSync(join(RETRO, `${TODAY}-stage-audit.md`), L.join('\n') + '\n');

// ---- apply（需 confirm-file；只应用 confirmed:true 的行）----
if (APPLY) {
  if (!confirmFile || !existsSync(confirmFile)) {
    console.error('❌ --apply 需要 --confirm-file <json>（把要执行的行标 confirmed:true）');
    process.exit(1);
  }
  const confirmed = new Set(JSON.parse(readFileSync(confirmFile, 'utf-8')).proposals.filter(p => p.confirmed).map(p => p.num));
  const toApply = proposals.filter(p => confirmed.has(p.num) && p.fields && Object.keys(p.fields).length);
  if (!toApply.length) { console.log('没有 confirmed:true 的可执行行，未写入。'); process.exit(0); }

  // 合并同 num 的多条建议（auditRow 每行只出一条，防御性处理）
  const byNum = new Map();
  for (const p of toApply) {
    if (!byNum.has(p.num)) byNum.set(p.num, { num: p.num, ...p.fields });
    else Object.assign(byNum.get(p.num), p.fields, { num: p.num });
  }
  const records = [...byNum.values()];

  // 逆操作：把本次写入的每个字段回置空（date→''，select→''）
  const inverse = records.map(r => {
    const { num, ...fields } = r;
    const back = {};
    for (const k of Object.keys(fields)) back[k] = '';
    return { num, ...back };
  });
  writeFileSync(join(RETRO, `${TODAY}-stage-audit-rollback.json`), JSON.stringify({ date: TODAY, inverse }, null, 2) + '\n');

  const { updated, missing } = await updateMany(records);
  console.log(`✅ 写入 ${updated} 行（missing: ${missing.join(', ') || '无'}）`);
  console.log(`↩️  回滚文件：data/retro/${TODAY}-stage-audit-rollback.json`);
  console.log('   刷新本地快照：npm run tracker:export');
}

console.log(`审计完成：${buckets.counts.audited} 建议（auto ${buckets.counts.auto} / confirm ${buckets.counts.needConfirm}）→ data/retro/${TODAY}-stage-audit.{md,json}`);
