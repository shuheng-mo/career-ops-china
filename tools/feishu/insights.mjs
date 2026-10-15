#!/usr/bin/env node
/**
 * insights.mjs — per-track funnel, and the Bitable dashboard that mirrors it.
 *
 * Two halves, deliberately separable:
 *
 *   1. The funnel itself, computed LOCALLY from the tracker abstraction. Works on
 *      either backend, needs no Feishu, prints to the terminal. This is the part
 *      that answers the question the Track column was added for: is the
 *      automotive direction actually converting, or just adding volume?
 *
 *   2. An optional Bitable dashboard with the same numbers as charts, for
 *      glancing at on a phone.
 *
 * ── Why this does NOT use `base +data-query` ──
 * The plan called for pushing aggregation into the cloud to replace the local
 * aggregateByStatus(). lark-cli's own query SOP picks the path by table size:
 * `+data-query` is the escape hatch for single-table stats above 2000 rows, and
 * below that the prescribed path is reading the records and analysing locally.
 * This table holds 242 rows. Cloud aggregation here would be slower, less
 * flexible (no multi-table JOIN, no window functions, no HAVING) and would not
 * work on the md backend at all. Revisit if the tracker ever passes ~2000 rows;
 * until then local is both correct and the documented choice.
 *
 * Run: node tools/feishu/insights.mjs [--dashboard] [--dry-run]
 */

import {
  listApplications, readProfileTracker, TRACKS, TRACK_FIT, trackDirection,
} from '../tracker-backend.mjs';
import { runLarkCli, parseJsonOut, isEnabled, skipped } from './capabilities.mjs';

// Funnel order. Blocked sits outside the progression on purpose: it is not a
// stage on the way to an offer, it is a hold with a reason.
const FUNNEL = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer'];
const OUTSIDE = ['Blocked', 'Rejected', 'Discarded', 'SKIP'];

// The 2026-07-03 → 2026-10-08 stall means pre-stall rows are historical stock.
// Mixing them into a response-rate denominator understates the restarted
// pipeline, so the funnel reports the two eras separately.
const RESTART_DATE = '2026-10-08';

export async function buildFunnel() {
  const apps = await listApplications();

  const bucket = () => ({ total: 0, byStatus: {}, scored: [] });
  const byTrack = new Map();
  const overall = { pre: bucket(), post: bucket() };

  for (const a of apps) {
    const era = (a.date || '') >= RESTART_DATE ? 'post' : 'pre';
    const key = a.track || '(未标注 = ai-app)';

    if (!byTrack.has(key)) byTrack.set(key, { pre: bucket(), post: bucket() });
    for (const target of [byTrack.get(key)[era], overall[era]]) {
      target.total++;
      target.byStatus[a.status] = (target.byStatus[a.status] || 0) + 1;
      const m = String(a.score || '').match(/([\d.]+)/);
      if (m) target.scored.push(parseFloat(m[1]));
    }
  }

  return { apps, byTrack, overall };
}

function avg(xs) {
  return xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}

/**
 * Conversion from "we applied" onward. Deliberately NOT measured from Evaluated:
 * a high Evaluated count with nothing applied is a different problem (the gate,
 * or inaction) and lumping them together hides which one it is.
 *
 * ⚠️ Known undercount. Status stores the CURRENT state, not a history, so a row
 * that went Interview → Rejected now reads as Rejected and is counted as sent
 * but never interviewed. Response and interview rates are therefore LOWER BOUNDS.
 * Fixing it properly needs per-stage timestamps (a Bitable change plus a writer
 * for them); until then the rates are labelled as such rather than quietly wrong.
 */
function rates(b) {
  const n = s => b.byStatus[s] || 0;
  // Everything that has at least been sent out.
  const sent = n('Applied') + n('Responded') + n('Interview') + n('Offer') + n('Rejected');
  const responded = n('Responded') + n('Interview') + n('Offer');
  const interviewed = n('Interview') + n('Offer');
  return {
    sent,
    responseRate: sent ? responded / sent : null,
    interviewRate: sent ? interviewed / sent : null,
  };
}

const pct = v => (v === null ? '  — ' : `${(v * 100).toFixed(0).padStart(3)}%`);

// CJK and full-width characters occupy two terminal columns, but String.padEnd
// counts code points — so a table padded with padEnd comes out ragged as soon as
// a header or a label is Chinese.
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && (
      c <= 0x115f ||                        // Hangul Jamo
      c === 0x2329 || c === 0x232a ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||  // CJK radicals … Yi
      (c >= 0xac00 && c <= 0xd7a3) ||       // Hangul syllables
      (c >= 0xf900 && c <= 0xfaff) ||       // CJK compat ideographs
      (c >= 0xfe30 && c <= 0xfe6f) ||       // CJK compat forms
      (c >= 0xff00 && c <= 0xff60) ||       // full-width forms
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff)        // emoji
    )) ? 2 : 1;
  }
  return w;
}
const padE = (s, n) => String(s) + ' '.repeat(Math.max(0, n - dispWidth(s)));
const padS = (s, n) => ' '.repeat(Math.max(0, n - dispWidth(s))) + String(s);

export function renderFunnel({ byTrack, overall }) {
  const L = [];
  L.push('=== career-ops 分 Track 漏斗 ===');
  L.push('');
  L.push(`重启分界：${RESTART_DATE}（之前是历史存量，回应率不要和重启后混算）`);
  L.push('⚠️ 回应率/进面率是**下界** —— Status 只存当前态，面试后被拒的行现在只剩 Rejected，');
  L.push('   统计里算作「投了但没面上」。要准确就得给每个阶段存时间戳。');
  L.push('');

  const head = `${padE('track', 22)} ${padE('fit', 14)} ${padS('条数', 6)} ${padS('已投', 6)} ${padS('回应', 6)} ${padS('进面', 6)} ${padS('均分', 6)}`;

  for (const era of ['post', 'pre']) {
    const label = era === 'post' ? `重启后（${RESTART_DATE} 起）` : `重启前（历史存量）`;
    if (overall[era].total === 0) {
      L.push(`${label}：无记录`);
      L.push('');
      continue;
    }
    L.push(`── ${label} ──`);
    L.push(head);

    // Stable order: the canonical track order, then anything unexpected.
    const keys = [...byTrack.keys()].sort((a, b) => {
      const ia = TRACKS.indexOf(a), ib = TRACKS.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    for (const k of keys) {
      const b = byTrack.get(k)[era];
      if (b.total === 0) continue;
      const r = rates(b);
      const fit = TRACK_FIT[k] || (k.includes('ai-app') ? 'primary' : '—');
      const a = avg(b.scored);
      L.push(`${padE(k, 22)} ${padE(fit, 14)} ${padS(b.total, 6)} ${padS(r.sent, 6)} ${padS(pct(r.responseRate), 6)} ${padS(pct(r.interviewRate), 6)} ${padS(a === null ? '—' : a.toFixed(1), 6)}`);
    }

    const ro = rates(overall[era]);
    const ao = avg(overall[era].scored);
    L.push(`${padE('—— 合计', 22)} ${padE('', 14)} ${padS(overall[era].total, 6)} ${padS(ro.sent, 6)} ${padS(pct(ro.responseRate), 6)} ${padS(pct(ro.interviewRate), 6)} ${padS(ao === null ? '—' : ao.toFixed(1), 6)}`);
    L.push('');

    // Direction rollup — the coarse "is the second direction paying off" read.
    const dir = {};
    for (const k of keys) {
      const b = byTrack.get(k)[era];
      if (b.total === 0) continue;
      const d = trackDirection(TRACKS.includes(k) ? k : '');
      dir[d] = dir[d] || { total: 0, sent: 0 };
      dir[d].total += b.total;
      dir[d].sent += rates(b).sent;
    }
    L.push('  方向汇总：' + Object.entries(dir).map(([d, v]) => `${d} ${v.total} 条 / 已投 ${v.sent}`).join('　'));
    L.push('');
  }

  const stateLine = s => {
    const c = (overall.post.byStatus[s] || 0) + (overall.pre.byStatus[s] || 0);
    return c ? `${s} ${c}` : null;
  };
  L.push('非漏斗状态：' + OUTSIDE.map(stateLine).filter(Boolean).join('　') || '非漏斗状态：无');

  return L.join('\n');
}

// ---- optional Bitable dashboard ----

/**
 * Dashboard blocks, declared once.
 *
 * ⚠️ Every `group_by` here targets a NATIVELY STORED field (`Status`, `Track`,
 * `Date`), never a formula field. Dashboard and view aggregations over formula
 * columns have silently returned wrong counts before — the API accepts the
 * request and the number is just off. So `Direction` (a formula) is NOT used as
 * a grouping key even though it would be the tidier axis; `Track` is finer
 * anyway and the direction rollup is done locally above.
 *
 * Positions are omitted on purpose: `+dashboard-arrange` does server-side smart
 * layout better than hand-picked 12-column coordinates.
 */
export const DASHBOARD_BLOCKS = [
  {
    name: '在库总数',
    type: 'statistics',
    dataConfig: t => ({ table_name: t, count_all: true }),
  },
  {
    // Was a funnel grouped by Status until 2026-10-15. Status is the CURRENT
    // state, so it is not a funnel: an interviewed-then-rejected row sits under
    // Rejected, and Discarded/SKIP dwarf everything. The real funnel (cumulative
    // reach per stage) is the Funnel-table chart synced by tools/feishu/pulse.mjs.
    name: '当前状态分布',
    type: 'column',
    dataConfig: t => ({
      table_name: t,
      count_all: true,
      group_by: [{ field_name: 'Status', mode: 'integrated', sort: { type: 'value', order: 'desc' } }],
    }),
  },
  {
    name: '分 Track 条数',
    type: 'column',
    dataConfig: t => ({
      table_name: t,
      count_all: true,
      group_by: [{ field_name: 'Track', mode: 'integrated' }],
    }),
  },
  {
    name: '待投（Evaluated）分 Track',
    type: 'bar',
    dataConfig: t => ({
      table_name: t,
      count_all: true,
      group_by: [{ field_name: 'Track', mode: 'integrated' }],
      // Status is a single-select, so `is` is the right operator and the filter
      // is over stored data — safe.
      filter: { conjunction: 'and', conditions: [{ field_name: 'Status', operator: 'is', value: 'Evaluated' }] },
    }),
  },
  {
    name: '按日期的投递量',
    type: 'line',
    dataConfig: t => ({
      table_name: t,
      count_all: true,
      group_by: [{ field_name: 'Date', mode: 'integrated' }],
    }),
  },
  {
    name: '说明',
    type: 'text',
    // text blocks take no data source. Only a small Markdown subset renders —
    // no links, images, code or tables.
    dataConfig: () => ({
      text: '## career-ops 求职看板\n'
        + '- **Track** = 技能轴 × 行业轴，决定北极星评分上限、投递闸门和 CV 选源\n'
        + '- **Blocked** 是活态，不是终态：命中证据缺口闸门，补齐后可解锁\n'
        + '- 空 Track 等于 *ai-app*（2026-10-10 之前的记录都是单方向）\n'
        + '- 回应率请分 2026-07-03 停摆前后看，别混算',
    }),
  },
];

export function syncDashboard({ dryRun = false, name = 'career-ops 求职看板' } = {}) {
  if (!isEnabled('dashboard')) return skipped('dashboard');

  const cfg = readProfileTracker();
  const appToken = cfg.bitable?.app_token;
  const tableId = cfg.bitable?.table_id_applications;
  if (!appToken || !tableId) {
    return { ok: false, error: 'tracker.bitable.app_token / table_id_applications 未配置' };
  }

  // data_config references the table by NAME, not id — resolve it rather than
  // assuming 'Applications'.
  let tableName = 'Applications';
  try {
    const out = parseJsonOut(runLarkCli(['base', '+table-list', '--base-token', appToken]));
    const items = out?.data?.items || out?.data?.tables || [];
    const hit = items.find(t => (t.table_id || t.id) === tableId);
    if (hit) tableName = hit.name || hit.table_name || tableName;
  } catch (e) {
    return { ok: false, error: `could not resolve the table name: ${e.message.split('\n')[0]}` };
  }

  // Reuse an existing dashboard of this name — re-running must not pile up copies.
  let dashboardId = null;
  try {
    const out = parseJsonOut(runLarkCli(['base', '+dashboard-list', '--base-token', appToken]));
    const items = out?.data?.items || out?.data?.dashboards || [];
    const hit = items.find(d => (d.name || d.dashboard_name) === name);
    if (hit) dashboardId = hit.dashboard_id || hit.id || hit.block_id;
  } catch { /* listing is best-effort; fall through to create */ }

  const steps = [];

  if (!dashboardId) {
    const args = ['base', '+dashboard-create', '--base-token', appToken, '--name', name];
    if (dryRun) {
      steps.push({ step: 'dashboard-create', dryRun: true, argv: args });
    } else {
      try {
        const out = parseJsonOut(runLarkCli(args, { write: true }));
        dashboardId = out?.data?.dashboard?.dashboard_id || out?.data?.dashboard_id || out?.data?.block_id;
        steps.push({ step: 'dashboard-create', ok: true, dashboardId });
      } catch (e) {
        return { ok: false, error: `dashboard-create failed: ${e.message.split('\n')[0]}`, steps };
      }
    }
  } else {
    steps.push({ step: 'dashboard-reuse', dashboardId });
  }

  // Which blocks already exist, so a re-run adds only what's missing.
  const existing = new Set();
  if (dashboardId && !dryRun) {
    try {
      const out = parseJsonOut(runLarkCli(['base', '+dashboard-block-list', '--base-token', appToken, '--dashboard-id', dashboardId]));
      for (const b of (out?.data?.items || out?.data?.blocks || [])) existing.add(b.name || b.block_name);
    } catch { /* best-effort */ }
  }

  for (const b of DASHBOARD_BLOCKS) {
    if (existing.has(b.name)) { steps.push({ step: 'block-skip', name: b.name }); continue; }
    const args = [
      'base', '+dashboard-block-create',
      '--base-token', appToken,
      '--dashboard-id', dashboardId || '<dashboard-id>',
      '--name', b.name,
      '--type', b.type,
      '--data-config', JSON.stringify(b.dataConfig(tableName)),
    ];
    if (dryRun) { steps.push({ step: 'block-create', dryRun: true, name: b.name, argv: args }); continue; }
    try {
      runLarkCli(args, { write: true });
      steps.push({ step: 'block-create', ok: true, name: b.name });
    } catch (e) {
      steps.push({ step: 'block-create', ok: false, name: b.name, error: e.message.split('\n')[0] });
    }
  }

  if (dashboardId && !dryRun) {
    try {
      runLarkCli(['base', '+dashboard-arrange', '--base-token', appToken, '--dashboard-id', dashboardId], { write: true });
      steps.push({ step: 'arrange', ok: true });
    } catch (e) {
      steps.push({ step: 'arrange', ok: false, error: e.message.split('\n')[0] });
    }
  }

  return { ok: true, skipped: false, dryRun, dashboardId, tableName, steps };
}

// CLI entry
if (process.argv[1] && process.argv[1].endsWith('insights.mjs')) {
  const data = await buildFunnel();
  console.log(renderFunnel(data));

  if (process.argv.includes('--dashboard')) {
    const dryRun = process.argv.includes('--dry-run');
    console.log(`\n=== Bitable 看板${dryRun ? '（dry-run）' : ''} ===`);
    const res = syncDashboard({ dryRun });
    if (res.skipped) console.log(`⏭  ${res.reason}`);
    else if (!res.ok) { console.error(`❌ ${res.error}`); process.exit(1); }
    else for (const s of res.steps) {
      console.log(s.argv
        ? `  ${s.step}: ${s.name || ''}\n    ${s.argv.map(a => (/[\s{]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`
        : `  ${s.step}: ${JSON.stringify(s)}`);
    }
  }
}
