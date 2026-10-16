#!/usr/bin/env node
/**
 * pulse.mjs — response-speed model, funnel by stage, and the "stop sending" signal.
 *
 * The question this answers: is the current batch of applications getting the
 * replies it should, given how long it has been out and where it was sent?
 * Answering that needs two things raw counts don't give you:
 *
 *  1. Censoring. An application sent yesterday has had one day to get a reply.
 *     Counting it as "no reply" makes every young batch look dead — which is
 *     exactly the misreading this tool exists to prevent. So response rates are
 *     survival-style: R(d) only counts applications at least d days old.
 *
 *  2. Channel. A careers portal answering after two weeks is normal; Boss going
 *     quiet for two weeks is not. Each channel gets its own baseline curve, taken
 *     from the candidate's own history (rows sent before the restart).
 *
 * ── The model ──
 * For each application in the live window, the baseline gives the probability it
 * should have answered by now: p_i = R_base,channel(age_i). Expected replies
 * E = Σ p_i. Observed O = replies actually received. Under "nothing has changed
 * since the baseline", O ~ Poisson(E). The tail probability P(X ≤ O | E) is the
 * signal:
 *     < 0.05  🟥 暂停投递 — this few replies is very unlikely if the CV/targeting
 *                         were as good as before. Stop and fix before sending more.
 *     < 0.20  🟨 观察     — below expectation; don't escalate volume.
 *     else    🟩 正常
 *  and E < 2 means there is not yet enough exposure to judge either way — the
 *  report says when there will be, instead of guessing.
 *
 * Speed is a separate check: if the median days-to-first-reply in the window is
 * more than 1.5× the baseline median, replies are coming slowly even if they come.
 *
 * Stage conversion separates "the CV isn't landing" (简历关 / 无回复 dominate)
 * from "the interviews aren't landing" (一面挂 dominates) — different fixes.
 *
 * Run:  node tools/feishu/pulse.mjs [--window 21] [--sync] [--dry-run]
 *       --sync writes weekly cohorts to the Bitable `Pulse` table and adds the
 *       pulse charts to the dashboard.
 */

import {
  listApplications, readProfileTracker, INTERVIEW_STAGES, EXIT_STAGES,
} from '../tracker-backend.mjs';
import { runLarkCli, parseJsonOut, isEnabled } from './capabilities.mjs';

export const RESTART_DATE = '2026-10-08';
const CHECKPOINTS = [3, 7, 14, 21];
const MAX_DAY = 30;

// ---- date helpers (Beijing calendar days) ----
const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const dayNum = s => Math.round(new Date(`${s}T00:00:00Z`).getTime() / 86400000);
const daysBetween = (a, b) => dayNum(b) - dayNum(a);
function isoWeek(s) {
  const d = new Date(`${s}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;                 // Mon = 0
  d.setUTCDate(d.getUTCDate() - day + 3);              // Thursday of this week
  const y = d.getUTCFullYear();                        // the Thursday's year is the ISO year
  const w = 1 + Math.floor((d - Date.UTC(y, 0, 1)) / 604800000);
  return `${y}-W${String(w).padStart(2, '0')}`;
}
const weekMonday = s => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

/** Applications that actually went out, with derived timing. */
export function sentRows(apps, today = todayStr()) {
  return apps
    .filter(a => a.appliedAt)
    .map(a => {
      const age = daysBetween(a.appliedAt, today);
      const ttfr = a.firstResponseAt ? Math.max(0, daysBetween(a.appliedAt, a.firstResponseAt)) : null;
      return { ...a, age, ttfr, era: a.appliedAt >= RESTART_DATE ? 'post' : 'pre' };
    });
}

/**
 * Survival-style response curve: R(d) = share answered within d days, among rows
 * old enough to have had d days. Returns R for d = 0..MAX_DAY, plus support n(d).
 */
export function responseCurve(rows) {
  const R = [], N = [];
  for (let d = 0; d <= MAX_DAY; d++) {
    const eligible = rows.filter(r => r.age >= d);
    const hit = eligible.filter(r => r.ttfr !== null && r.ttfr <= d).length;
    N.push(eligible.length);
    R.push(eligible.length ? hit / eligible.length : null);
  }
  // Make it monotone non-decreasing: support shrinks as d grows, so raw R(d) can
  // dip from noise, and a "probability of having replied by day d" cannot fall.
  for (let d = 1; d <= MAX_DAY; d++) if (R[d] !== null && R[d - 1] !== null && R[d] < R[d - 1]) R[d] = R[d - 1];
  return { R, N };
}

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/** P(X ≤ k) for X ~ Poisson(lambda). */
function poissonCdf(k, lambda) {
  let term = Math.exp(-lambda), sum = term;
  for (let i = 1; i <= k; i++) { term *= lambda / i; sum += term; }
  return Math.min(1, sum);
}

/**
 * Per-channel baseline from pre-restart history. A channel with fewer than
 * MIN_CHANNEL_N historical sends borrows the pooled curve — a curve fitted to 3
 * rows would make one lucky reply look like the norm.
 */
const MIN_CHANNEL_N = 8;
export function buildBaseline(rows) {
  const hist = rows.filter(r => r.era === 'pre');
  const pooled = responseCurve(hist);
  const byChannel = {};
  for (const ch of new Set(hist.map(r => r.channel || '其他'))) {
    const sub = hist.filter(r => (r.channel || '其他') === ch);
    byChannel[ch] = { n: sub.length, own: sub.length >= MIN_CHANNEL_N, ...(sub.length >= MIN_CHANNEL_N ? responseCurve(sub) : pooled) };
  }
  const ttfrs = hist.filter(r => r.ttfr !== null).map(r => r.ttfr);
  return { n: hist.length, pooled, byChannel, ttfrMedian: median(ttfrs), ttfrP80: quantile(ttfrs, 0.8) };
}

const curveFor = (base, ch) => (base.byChannel[ch || '其他'] || base.pooled);
const at = (curve, age) => curve.R[Math.min(MAX_DAY, Math.max(0, age))] ?? 0;

/** Expected vs observed replies for the live window, and the resulting signal. */
export function assessWindow(rows, base, windowDays = 21) {
  const live = rows.filter(r => r.era === 'post' && r.age <= windowDays && r.age >= 0);
  const E = live.reduce((s, r) => s + at(curveFor(base, r.channel), r.age), 0);
  const O = live.filter(r => r.firstResponseAt).length;
  const p = poissonCdf(O, E);
  const ttfrs = live.filter(r => r.ttfr !== null).map(r => r.ttfr);
  const ttfrMed = median(ttfrs);
  // 1.5× alone misfires when the historical median is 0 days (Boss same-day
  // replies): then a 1-day reply would read as "slow". Require 2+ days too.
  const slow = ttfrMed !== null && base.ttfrMedian !== null && ttfrs.length >= 3
    && ttfrMed > Math.max(1.5 * base.ttfrMedian, base.ttfrMedian + 2);

  let signal, reason;
  if (E < 2) {
    // When will exposure be enough? Project forward with no new sends and no replies.
    let day = 0, Ef = E;
    while (Ef < 2 && day < 30) { day++; Ef = live.reduce((s, r) => s + at(curveFor(base, r.channel), r.age + day), 0); }
    signal = '⚪ 数据不足';
    reason = `按历史基线，到今天只该收到 ${E.toFixed(1)} 个回复，还不足以判断${Ef >= 2 ? `；约 ${day} 天后（期望值到 2）可以下结论` : ''}`;
  } else if (p < 0.05) {
    signal = '🟥 暂停投递';
    reason = `期望 ${E.toFixed(1)} 个回复，实际 ${O} 个；如果简历和定位还和历史一样，这么少的概率只有 ${(p * 100).toFixed(1)}%。先停下改简历/渠道/定位，再投`;
  } else if (p < 0.2 || slow) {
    signal = '🟨 观察';
    reason = p < 0.2
      ? `期望 ${E.toFixed(1)} 个回复，实际 ${O} 个，低于预期（P=${(p * 100).toFixed(0)}%）；不要加量，先看下一周`
      : `回复数正常，但回复中位数 ${ttfrMed} 天，比历史 ${base.ttfrMedian} 天明显慢（超过 1.5 倍且多 2 天以上）`;
  } else {
    signal = '🟩 正常';
    reason = `期望 ${E.toFixed(1)} 个回复，实际 ${O} 个`;
  }
  return { live, E, O, p, ttfrMed, slow, signal, reason, windowDays };
}

/**
 * Second, stricter test: would the healthiest month have done better with the
 * same sends? Careers-portal rows keep the history curve — the best month was
 * almost all Boss, whose same-day replies would make a portal look broken.
 */
function healthyCheck(rows, base, best, windowDays) {
  const live = rows.filter(r => r.era === 'post' && r.age <= windowDays && r.age >= 0);
  const E = live.reduce((s, r) => s + at(r.channel === '官网' ? curveFor(base, r.channel) : best.curve, r.age), 0);
  const O = live.filter(r => r.firstResponseAt).length;
  return { month: best.month, n: best.n, r7: best.curve.R[7], E, O, p: poissonCdf(O, E) };
}

/** Weekly cohorts by Applied At. */
export function cohorts(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = weekMonday(r.appliedAt);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([monday, rs]) => {
    const c = responseCurve(rs);
    const pick = d => (c.N[d] >= Math.max(3, Math.ceil(rs.length / 2)) ? c.R[d] : null);   // only report a checkpoint once most of the cohort has reached it
    const interviewed = rs.filter(r => INTERVIEW_STAGES.indexOf(r.furthestStage) >= INTERVIEW_STAGES.indexOf('一面')).length;
    return {
      week: isoWeek(monday), monday, n: rs.length,
      responded: rs.filter(r => r.firstResponseAt).length,
      r: Object.fromEntries(CHECKPOINTS.map(d => [d, pick(d)])),
      interviewed,
      ttfrMed: median(rs.filter(r => r.ttfr !== null).map(r => r.ttfr)),
      channels: Object.entries(rs.reduce((m, r) => ((m[r.channel || '其他'] = (m[r.channel || '其他'] || 0) + 1), m), {})).map(([k, v]) => `${k}${v}`).join(' '),
    };
  });
}

/** Stage funnel and exit distribution. */
export function stageFunnel(rows) {
  const reached = s => rows.filter(r => INTERVIEW_STAGES.indexOf(r.furthestStage) >= INTERVIEW_STAGES.indexOf(s)).length;
  const exits = Object.fromEntries(EXIT_STAGES.map(e => [e, rows.filter(r => r.exitStage === e).length]));
  return {
    sent: rows.length,
    // Reaching any stage implies a reply even when its date was never recorded.
    responded: rows.filter(r => r.firstResponseAt || r.firstResponse || r.furthestStage).length,
    stages: ['一面', '二面', '终面', 'Offer'].map(s => ({ stage: s, n: reached(s) })),
    exits,
  };
}

/** Which problem is it? CV/targeting vs interview performance. */
function diagnose(f) {
  const out = [];
  const closed = Object.values(f.exits).reduce((a, b) => a + b, 0) - (f.exits['录用'] || 0);
  if (!closed) return out;
  const cv = (f.exits['简历关'] || 0) + (f.exits['无回复'] || 0);
  const iv = ['笔试挂', '一面挂', '二面挂', '三面挂', 'HR面挂', '终面挂'].reduce((s, k) => s + (f.exits[k] || 0), 0);
  out.push(`结束的 ${closed} 个流程里：卡在简历/无回复 ${cv} 个（${pct(cv / closed)}），面试中被挂 ${iv} 个（${pct(iv / closed)}）`);
  const one = f.stages.find(s => s.stage === '一面').n, two = f.stages.find(s => s.stage === '二面').n;
  if (one) out.push(`一面 → 二面 通过率 ${pct(two / one)}（${two}/${one}）`);
  if (f.responded) out.push(`回复 → 进面 ${pct(one / f.responded)}（${one}/${f.responded}）`);
  return out;
}

const pct = v => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${Math.round(v * 100)}%`);

export async function buildPulse({ windowDays = 21 } = {}) {
  const apps = await listApplications();
  const rows = sentRows(apps);
  const base = buildBaseline(rows);
  // Processes that clearly went out (they have a channel or reached a stage) but
  // whose send date was never written down. The speed model can't use them — no
  // clock — but the stage funnel must, or the one process that reached a final
  // round would vanish from the funnel.
  const undated = apps
    .filter(a => !a.appliedAt && (a.channel || a.furthestStage || a.exitStage))
    .map(a => ({ ...a, age: null, ttfr: null, era: (a.date || '') >= RESTART_DATE ? 'post' : 'pre' }));
  const funnelRows = [...rows, ...undated];
  // A stricter yardstick than the all-history average: the best calendar month
  // with at least 10 sends. "Normal vs history" can still be far below what the
  // same CV achieved when the targeting was right. Month, not week: a 6-send week
  // with 5 replies is luck, not a benchmark.
  const preRows = rows.filter(r => r.era === 'pre');
  const months = [...new Set(preRows.map(r => r.appliedAt.slice(0, 7)))].map(m => {
    const sub = preRows.filter(r => r.appliedAt.startsWith(m));
    return { month: m, n: sub.length, curve: responseCurve(sub) };
  }).filter(m => m.n >= 10 && m.curve.R[7] !== null).sort((a, b) => b.curve.R[7] - a.curve.R[7]);
  const best = months[0] || null;
  const window = assessWindow(rows, base, windowDays);
  const healthy = best && healthyCheck(rows, base, best, windowDays);
  // Escalate green to yellow when the window also trails the healthiest month.
  let signal = window.signal, reason = window.reason;
  if (signal === '🟩 正常' && healthy && healthy.E >= 2 && healthy.p < 0.05) {
    signal = '🟨 观察';
    reason += `；但比 ${healthy.month} 健康期差很多（P=${(healthy.p * 100).toFixed(1)}%），不要加量`;
  }
  return {
    today: todayStr(),
    rows, base, signal, reason,
    window,
    cohorts: cohorts(rows),
    funnel: { pre: stageFunnel(funnelRows.filter(r => r.era === 'pre')), post: stageFunnel(funnelRows.filter(r => r.era === 'post')) },
    best: healthy,
    evaluated: { pre: apps.filter(a => (a.date || '') < RESTART_DATE).length, post: apps.filter(a => (a.date || '') >= RESTART_DATE).length },
    undated: undated.map(a => a.num),
    missingAppliedAt: apps.filter(a => ['Applied', 'Responded', 'Interview', 'Offer'].includes(a.status) && !a.appliedAt).map(a => a.num),
  };
}

export function renderPulse(P) {
  const L = [];
  const { base, window: w } = P;
  L.push(`=== 投递脉搏 ${P.today} ===`, '');
  L.push(`信号：${P.signal}`);
  L.push(`      ${P.reason}`);
  L.push(`      窗口：近 ${w.windowDays} 天投出 ${w.live.length} 个；回复中位 ${w.ttfrMed ?? '—'} 天（历史 ${base.ttfrMedian ?? '—'} 天，80% 在 ${base.ttfrP80 ?? '—'} 天内）`);
  if (P.best) L.push(`      对照最好的月份 ${P.best.month}（${P.best.n} 个投递，7 天回复 ${pct(P.best.r7)}）：同样的投递那时应收到 ${P.best.E.toFixed(1)} 个回复（官网按历史曲线算）`);
  if (P.missingAppliedAt.length) L.push(`      ⚠️ ${P.missingAppliedAt.length} 个在途岗位缺 Applied At，没进模型：#${P.missingAppliedAt.join(' #')}`);
  L.push('');

  L.push(`── 历史基线（重启前 ${base.n} 个已投）──`);
  L.push(`渠道        样本  3天   7天   14天  21天`);
  const line = (name, c, n, own) => `${(name + '　　　　').slice(0, 5)}  ${String(n).padStart(4)}  ${CHECKPOINTS.map(d => pct(c.R[d]).padStart(4)).join('  ')}${own === false ? '  （样本少，用合计曲线）' : ''}`;
  L.push(line('合计', base.pooled, base.n));
  for (const [ch, c] of Object.entries(base.byChannel).sort((a, b) => b[1].n - a[1].n)) L.push(line(ch, c, c.n, c.own));
  L.push('');

  L.push('── 每周批次（按投递周）──');
  L.push('周          投递  回复  3天   7天   14天  进面  回复中位  渠道');
  for (const c of P.cohorts) {
    L.push(`${c.week}  ${String(c.n).padStart(4)}  ${String(c.responded).padStart(4)}  ${CHECKPOINTS.slice(0, 3).map(d => pct(c.r[d]).padStart(4)).join('  ')}  ${String(c.interviewed).padStart(4)}  ${String(c.ttfrMed ?? '—').padStart(6)}    ${c.channels}`);
  }
  L.push('（百分比只在大部分投递已满该天数时才显示，避免把刚投的算成没回）', '');

  for (const era of ['pre', 'post']) {
    const f = P.funnel[era];
    if (!f.sent) continue;
    L.push(`── 阶段漏斗 · ${era === 'pre' ? '重启前' : '重启后'} ──`);
    L.push(`评估 ${P.evaluated[era]} → 投递 ${f.sent} → 回复 ${f.responded} → ` + f.stages.map(s => `${s.stage} ${s.n}`).join(' → '));
    const ex = Object.entries(f.exits).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join('　');
    if (ex) L.push(`出局：${ex}`);
    for (const d of diagnose(f)) L.push(`  · ${d}`);
    L.push('');
  }
  if (P.undated.length) L.push(`（#${P.undated.join(' #')} 进了流程但没记投递日期：算进阶段漏斗，不算进回复速度）`);
  return L.join('\n');
}

// ---- Bitable: Pulse table + dashboard blocks ----

const PULSE_FIELDS = [
  { type: 'text', name: 'Week', style: { type: 'plain' } },
  { type: 'datetime', name: 'Monday', style: { format: 'yyyy-MM-dd' } },
  { type: 'number', name: 'Sent', style: { type: 'plain', precision: 0, thousands_separator: false } },
  { type: 'number', name: 'Responded', style: { type: 'plain', precision: 0, thousands_separator: false } },
  { type: 'number', name: 'R3 %', style: { type: 'plain', precision: 0, thousands_separator: false } },
  { type: 'number', name: 'R7 %', style: { type: 'plain', precision: 0, thousands_separator: false } },
  { type: 'number', name: 'R14 %', style: { type: 'plain', precision: 0, thousands_separator: false } },
  { type: 'number', name: 'Interviewed', style: { type: 'plain', precision: 0, thousands_separator: false } },
  { type: 'number', name: 'Median Days To Reply', style: { type: 'plain', precision: 1, thousands_separator: false } },
  { type: 'text', name: 'Channels', style: { type: 'plain' } },
  { type: 'text', name: 'Signal', style: { type: 'plain' } },
];

function ensurePulseTable(appToken) {
  const cfg = readProfileTracker();
  if (cfg.bitable?.table_id_pulse) return cfg.bitable.table_id_pulse;
  const list = parseJsonOut(runLarkCli(['base', '+table-list', '--base-token', appToken]));
  const items = list?.data?.items || list?.data?.tables || [];
  const hit = items.find(t => (t.name || t.table_name) === 'Pulse');
  if (hit) return hit.table_id || hit.id;
  const out = parseJsonOut(runLarkCli([
    'base', '+table-create', '--base-token', appToken, '--name', 'Pulse',
    '--fields', JSON.stringify(PULSE_FIELDS), '--view', JSON.stringify([{ name: 'All', type: 'grid' }]),
  ], { write: true, timeoutMs: 60000 }));
  const t = out?.table || out?.data?.table || out?.data || out;
  return t?.table_id || t?.id;
}

/** Upsert one row per week, keyed by Week. Never deletes. */
export function syncPulseTable(P, { dryRun = false } = {}) {
  const cfg = readProfileTracker();
  const appToken = cfg.bitable?.app_token;
  if (!appToken) return { ok: false, error: 'tracker.bitable.app_token 未配置' };
  if (dryRun) return { ok: true, dryRun: true, rows: P.cohorts.length };
  const tableId = ensurePulseTable(appToken);

  const existing = new Map();
  const d = parseJsonOut(runLarkCli(['base', '+record-list', '--base-token', appToken, '--table-id', tableId, '--limit', '200']))?.data || {};
  const wi = (d.fields || []).indexOf('Week');
  (d.data || []).forEach((row, i) => existing.set(row[wi], d.record_id_list[i]));

  const latest = P.cohorts.at(-1)?.week;
  for (const c of P.cohorts) {
    const f = {
      Week: c.week, Monday: `${c.monday} 00:00:00`, Sent: c.n, Responded: c.responded,
      'R3 %': c.r[3] === null ? null : Math.round(c.r[3] * 100),
      'R7 %': c.r[7] === null ? null : Math.round(c.r[7] * 100),
      'R14 %': c.r[14] === null ? null : Math.round(c.r[14] * 100),
      Interviewed: c.interviewed, 'Median Days To Reply': c.ttfrMed, Channels: c.channels,
      Signal: c.week === latest ? `${P.signal}｜${P.reason}` : '',
    };
    const args = ['base', '+record-upsert', '--base-token', appToken, '--table-id', tableId, '--json', JSON.stringify(f)];
    if (existing.has(c.week)) args.splice(6, 0, '--record-id', existing.get(c.week));
    runLarkCli(args, { write: true });
  }
  return { ok: true, tableId, rows: P.cohorts.length };
}

// ---- Funnel table: cumulative "reached at least this stage" counts ----
const FUNNEL_FIELDS = [
  { type: 'text', name: 'Key', style: { type: 'plain' } },
  { type: 'text', name: 'Era', style: { type: 'plain' } },
  { type: 'text', name: 'Stage', style: { type: 'plain' } },
  { type: 'number', name: 'Order', style: { type: 'plain', precision: 0, thousands_separator: false } },
  { type: 'number', name: 'Count', style: { type: 'plain', precision: 0, thousands_separator: false } },
  { type: 'number', name: '% of Sent', style: { type: 'plain', precision: 1, thousands_separator: false } },
];
// 三面 is left out on purpose: 终面 means "the final round", whatever its number
// (a two-round process's CTO round is its 终面). Showing 三面 would count every
// process that reached a final round as having had a third round.
export const FUNNEL_STAGES = ['投递', '有回复', '一面', '二面', '终面', 'Offer'];

export function funnelRows(P) {
  const both = (k, s) => (P.funnel.pre[k] ?? 0) + (P.funnel.post[k] ?? 0);
  const out = [];
  for (const [era, f] of [['重启前', P.funnel.pre], ['重启后', P.funnel.post], ['全部', null]]) {
    const get = st => {
      const src = f ? [f] : [P.funnel.pre, P.funnel.post];
      return src.reduce((s, x) => s + (st === '投递' ? x.sent : st === '有回复' ? x.responded : x.stages.find(y => y.stage === st).n), 0);
    };
    const sent = get('投递');
    FUNNEL_STAGES.forEach((st, i) => out.push({ Key: `${era}|${st}`, Era: era, Stage: st, Order: i + 1, Count: get(st), '% of Sent': sent ? Math.round(get(st) / sent * 1000) / 10 : 0 }));
  }
  return out;
}

function ensureTable(appToken, name, fields) {
  const list = parseJsonOut(runLarkCli(['base', '+table-list', '--base-token', appToken]));
  const hit = (list?.data?.items || list?.data?.tables || []).find(t => (t.name || t.table_name) === name);
  if (hit) return hit.table_id || hit.id;
  const out = parseJsonOut(runLarkCli(['base', '+table-create', '--base-token', appToken, '--name', name,
    '--fields', JSON.stringify(fields), '--view', JSON.stringify([{ name: 'All', type: 'grid' }])], { write: true, timeoutMs: 60000 }));
  const t = out?.table || out?.data?.table || out?.data || out;
  return t?.table_id || t?.id;
}

/** Upsert the funnel rows keyed by Key. Rows are written in stage order so the chart's view order is the funnel order. */
export function syncFunnelTable(P, { dryRun = false } = {}) {
  const appToken = readProfileTracker().bitable?.app_token;
  const rows = funnelRows(P);
  if (dryRun) return { ok: true, dryRun: true, rows };
  const tableId = ensureTable(appToken, 'Funnel', FUNNEL_FIELDS);
  const d = parseJsonOut(runLarkCli(['base', '+record-list', '--base-token', appToken, '--table-id', tableId, '--limit', '200']))?.data || {};
  const ki = (d.fields || []).indexOf('Key');
  const existing = new Map((d.data || []).map((r, i) => [r[ki], d.record_id_list[i]]));
  for (const f of rows) {
    const args = ['base', '+record-upsert', '--base-token', appToken, '--table-id', tableId, '--json', JSON.stringify(f)];
    if (existing.has(f.Key)) args.splice(6, 0, '--record-id', existing.get(f.Key));
    runLarkCli(args, { write: true });
  }
  return { ok: true, tableId, rows };
}

/** Dashboard blocks for the pulse. Appended to the existing insights dashboard. */
// ⚠️ A funnel/bar grouped directly by `Furthest Stage` is WRONG, and shipped that
// way once: grouping counts each value separately (a row that reached 二面 is
// counted only under 二面, not under 一面), so the bars are not "how many got at
// least this far", and the hundreds of never-sent rows land in an empty bucket
// that dwarfs everything. Bitable cannot compute a cumulative count over a
// select, so the funnel is computed here and written to the `Funnel` table, one
// row per (era, stage), and charted from there in row order.
// Every chart over Applications filters out empty cells for the same reason.
const notEmpty = f => ({ conjunction: 'and', conditions: [{ field_name: f, operator: 'isNotEmpty' }] });
const inOrder = { type: 'view', order: 'asc' };
export const PULSE_BLOCKS = [
  { name: '每周投递量', type: 'column', table: 'Pulse', dataConfig: t => ({ table_name: t, series: [{ field_name: 'Sent', rollup: 'SUM' }], group_by: [{ field_name: 'Week', mode: 'integrated', sort: inOrder }] }) },
  { name: '每周 7 天回复率 %', type: 'line', table: 'Pulse', dataConfig: t => ({ table_name: t, series: [{ field_name: 'R7 %', rollup: 'SUM' }], group_by: [{ field_name: 'Week', mode: 'integrated', sort: inOrder }] }) },
  { name: '回复中位天数（按周）', type: 'line', table: 'Pulse', dataConfig: t => ({ table_name: t, series: [{ field_name: 'Median Days To Reply', rollup: 'SUM' }], group_by: [{ field_name: 'Week', mode: 'integrated', sort: inOrder }] }) },
  { name: '投递渠道', type: 'pie', table: 'Applications', dataConfig: t => ({ table_name: t, count_all: true, group_by: [{ field_name: 'Channel', mode: 'integrated' }], filter: notEmpty('Channel') }) },
  { name: '首次回复类型', type: 'pie', table: 'Applications', dataConfig: t => ({ table_name: t, count_all: true, group_by: [{ field_name: 'First Response', mode: 'integrated' }], filter: notEmpty('First Response') }) },
  { name: '漏斗：投递到 Offer（累计到达）', renameFrom: '最远走到哪一轮', type: 'funnel', table: 'Funnel', dataConfig: t => ({ table_name: t, series: [{ field_name: 'Count', rollup: 'SUM' }], group_by: [{ field_name: 'Stage', mode: 'integrated', sort: inOrder }], filter: { conjunction: 'and', conditions: [{ field_name: 'Era', operator: 'is', value: '全部' }, { field_name: 'Stage', operator: 'isNot', value: '三面' }] } }) },   // 三面 rows predate FUNNEL_STAGES dropping it; filtered rather than deleted (record-delete is a --yes operation)
  { name: '在哪一轮出局', type: 'bar', table: 'Applications', dataConfig: t => ({ table_name: t, count_all: true, group_by: [{ field_name: 'Exit Stage', mode: 'integrated', sort: { type: 'value', order: 'desc' } }], filter: notEmpty('Exit Stage') }) },
];

export function syncPulseDashboard({ dryRun = false, name = 'career-ops 求职看板' } = {}) {
  if (!isEnabled('dashboard')) return { ok: true, skipped: true };
  const appToken = readProfileTracker().bitable?.app_token;
  const tables = parseJsonOut(runLarkCli(['base', '+table-list', '--base-token', appToken]));
  const titems = tables?.data?.items || tables?.data?.tables || [];
  const appTableId = readProfileTracker().bitable?.table_id_applications;
  const tableName = id => (titems.find(t => (t.table_id || t.id) === id) || {}).name;
  const names = { Pulse: 'Pulse', Funnel: 'Funnel', Applications: tableName(appTableId) || 'Applications' };

  const dl = parseJsonOut(runLarkCli(['base', '+dashboard-list', '--base-token', appToken]));
  const dash = (dl?.data?.items || dl?.data?.dashboards || []).find(d => (d.name || d.dashboard_name) === name);
  if (!dash) return { ok: false, error: `没找到看板「${name}」，先跑 node tools/feishu/insights.mjs --dashboard` };
  const dashboardId = dash.dashboard_id || dash.id || dash.block_id;

  const have = new Map();
  const bl = parseJsonOut(runLarkCli(['base', '+dashboard-block-list', '--base-token', appToken, '--dashboard-id', dashboardId]));
  for (const b of (bl?.data?.items || bl?.data?.blocks || [])) have.set(b.name || b.block_name, b.block_id || b.id);

  // Declarative: an existing block is UPDATED to the current config, so fixing a
  // definition here fixes the live chart on the next --sync (block types can't
  // change in place; none of these need to).
  const steps = [];
  for (const b of PULSE_BLOCKS) {
    const cfgJson = JSON.stringify(b.dataConfig(names[b.table]));
    const existingId = have.get(b.name) || (b.renameFrom && have.get(b.renameFrom));
    if (existingId) {
      const args = ['base', '+dashboard-block-update', '--base-token', appToken, '--dashboard-id', dashboardId,
        '--block-id', existingId, '--data-config', cfgJson];
      if (!have.has(b.name)) args.push('--name', b.name);
      if (dryRun) { steps.push({ name: b.name, argv: args }); continue; }
      try { runLarkCli(args, { write: true }); steps.push({ name: b.name, ok: true, updated: true }); }
      catch (e) { steps.push({ name: b.name, ok: false, error: e.message.split('\n')[0] }); }
      continue;
    }
    const args = ['base', '+dashboard-block-create', '--base-token', appToken, '--dashboard-id', dashboardId,
      '--name', b.name, '--type', b.type, '--data-config', cfgJson];
    if (dryRun) { steps.push({ name: b.name, argv: args }); continue; }
    try { runLarkCli(args, { write: true }); steps.push({ name: b.name, ok: true }); }
    catch (e) { steps.push({ name: b.name, ok: false, error: e.message.split('\n')[0] }); }
  }
  if (!dryRun) { try { runLarkCli(['base', '+dashboard-arrange', '--base-token', appToken, '--dashboard-id', dashboardId], { write: true }); } catch { /* layout is cosmetic */ } }
  return { ok: true, dashboardId, steps };
}

// ---- CLI ----
if (process.argv[1] && process.argv[1].endsWith('pulse.mjs')) {
  const i = process.argv.indexOf('--window');
  const P = await buildPulse({ windowDays: i > -1 ? Number(process.argv[i + 1]) : 21 });
  console.log(renderPulse(P));
  if (process.argv.includes('--sync')) {
    const dryRun = process.argv.includes('--dry-run');
    const t = syncPulseTable(P, { dryRun });
    console.log(`\nPulse 表：${t.ok ? `✅ ${t.rows} 周` : `❌ ${t.error}`}`);
    const fu = syncFunnelTable(P, { dryRun });
    console.log(`Funnel 表：✅ ${fu.rows.length} 行（全部：${fu.rows.filter(r => r.Era === '全部').map(r => `${r.Stage} ${r.Count}`).join(' → ')}）`);
    const d = syncPulseDashboard({ dryRun });
    if (d.skipped) console.log('看板：dashboard 能力未开启，跳过');
    else if (!d.ok) console.log(`看板：❌ ${d.error}`);
    else for (const s of d.steps) console.log(`  ${s.ok === false ? '❌' : s.updated ? '🔄' : '➕'} ${s.name}${s.error ? ` — ${s.error}` : ''}`);
  }
}
