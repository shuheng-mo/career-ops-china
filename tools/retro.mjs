#!/usr/bin/env node
/**
 * retro.mjs — `npm run retro`: write a retro DRAFT for Claude to read.
 *
 * The script lays out evidence only: three cohorts (baseline month / the retro
 * line's window / everything since the restart, all at least 14 days old)
 * compared dimension by dimension as positive replies `x/n (%)`, with
 * application numbers, plus the lists a retro acts on. The three judgement
 * sections — 解读 / 调整 / 下次复盘要回答的问题 — are left empty under a
 * placeholder, filled in conversation with the candidate. A file still carrying
 * the placeholder is a draft: it does NOT silence the retro alert (see
 * decideAlert in retro-core.mjs).
 *
 * Output: data/retro/{YYYY-MM-DD}-retro.md (gitignored — it holds company names).
 * Run:    node tools/retro.mjs [--force] [--stdout]
 *
 * Spec: docs/superpowers/specs/2026-11-16-retro-trigger-design.md §3.5
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { listApplications, TRACK_FIT } from './tracker-backend.mjs';
import { RESTART_DATE } from './feishu/pulse.mjs';
import {
  CAREER_OPS, RETRO_DIR, PLACEHOLDER, todayBJ, day, daysBetween,
  isPositive, responseKind, matured, retroWindow, baseline, retroLine,
  readRetroConfig, listRetros, readAlertState,
} from './retro-core.mjs';

// ---- report header fields ----
const UNSET = '未标注';
const headerCache = new Map();

/** Tier letter and 可达性 from an evaluation report's header; anything missing reads as 未标注. */
export function parseReportHeader(reportField, root = CAREER_OPS) {
  const m = String(reportField || '').match(/\]\(([^)]+\.md)\)/);
  if (!m) return { tier: UNSET, reach: UNSET };
  const path = join(root, m[1]);
  if (headerCache.has(path)) return headerCache.get(path);
  let tier = UNSET, reach = UNSET;
  if (existsSync(path)) {
    const head = readFileSync(path, 'utf-8').split('\n').slice(0, 25).join('\n');
    const t = head.match(/\*\*Tier[：:]\*\*\s*(?:\*\*)?\s*(?:Tier\s*)?([ABCD])/);
    const r = head.match(/\*\*可达性[：:]\*\*\s*([高中低])/);
    if (t) tier = t[1];
    if (r) reach = r[1];
  }
  const out = { tier, reach };
  headerCache.set(path, out);
  return out;
}

// fit × Tier, mirroring modes/_shared.md「投递闸门」. Unlabelled Tier uses the A/B row.
const GATE = {
  primary: { AB: 3.8, C: 4.0 },
  secondary: { AB: 4.1, C: 4.3 },
  bridge: { AB: 4.1, C: Infinity },
};
export function gateFor(track, tier) {
  const fit = TRACK_FIT[track || 'ai-app'] || 'primary';
  if (tier === 'D' || !GATE[fit]) return Infinity;      // Tier D never; evidence-gated goes through its own gate
  return tier === 'C' ? GATE[fit].C : GATE[fit].AB;
}

// The `数据Agent` tag is written from 2026-11-16 on; earlier rows get a keyword split.
const TAG_SINCE = '2026-11-16';
const AI_WORDS = /agent|智能体|大模型|llm|\bAI\b|aigc|rag|gpt/i;
const DATA_WORDS = /数据|data|nl2sql|text2sql|chatbi|\bBI\b|问数|指标|\bsql\b/i;
export function direction(app) {
  if (String(app.notes || '').includes('数据Agent')) return '数据Agent';
  if (day(app.date) >= TAG_SINCE) return '非数据Agent';
  const text = `${app.role || ''} ${app.notes || ''}`;
  return AI_WORDS.test(text) && DATA_WORDS.test(text) ? '数据Agent（粗分）' : '非数据Agent（粗分）';
}

// ---- formatting ----
const pct = (pos, n) => `${pos}/${n} (${Math.round((pos / n) * 100)}%)`;
const cell = (rows) => {
  if (!rows.length) return '—';
  const s = pct(rows.filter(isPositive).length, rows.length);
  return rows.length < 5 ? `${s}（样本小）` : s;
};
const scoreOf = (a) => { const m = String(a.score || '').match(/([\d.]+)/); return m ? parseFloat(m[1]) : null; };
const scoreBand = (a) => { const s = scoreOf(a); return s === null ? '无分' : s >= 4 ? '≥4.0' : s >= 3.5 ? '3.5–3.9' : '<3.5'; };
const nums = (rows) => rows.filter(isPositive).map(a => `#${a.num}`).join(' ') || '无';

function dimTable(title, cohorts, keyFn, note = '') {
  const keys = new Map();
  for (const c of cohorts) for (const a of c.rows) { const k = keyFn(a); keys.set(k, (keys.get(k) || 0) + 1); }
  const order = [...keys.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k);
  const L = [`### ${title}`, '', `| ${title} | ${cohorts.map(c => c.label).join(' | ')} |`, `|---|${cohorts.map(() => '---').join('|')}|`];
  for (const k of order) L.push(`| ${k} | ${cohorts.map(c => cell(c.rows.filter(a => keyFn(a) === k))).join(' | ')} |`);
  if (note) L.push('', note);
  return L.join('\n');
}

function previousQuestions(retros, today) {
  const prev = retros.filter(r => r.date < today).pop();
  if (!prev) return '无上次报告。';
  const text = readFileSync(prev.file, 'utf-8');
  const m = text.match(/## 下次复盘要回答的问题[^\n]*\n([\s\S]*?)(?=\n## |$)/);
  const body = m ? m[1].trim() : '';
  if (!body) return `上次报告（${prev.date}）没有这一节。`;
  const items = body.split('\n').filter(l => l.trim()).map(l => (/^\s*[-*]/.test(l) ? `${l}\n  → ` : l));
  return [`来自 ${prev.date} 的报告，逐条填答：`, '', ...items].join('\n');
}

export function buildRetroReport(apps, { today = todayBJ(), baselineMonth, trigger = 'manual', retros = [] } = {}) {
  const line = retroLine(apps, { today, baselineMonth });
  const base = baselineMonth ? baseline(apps, baselineMonth, today) : { rows: [] };
  const win = retroWindow(apps, today);
  const post = matured(apps, today).filter(a => day(a.contactedAt || a.appliedAt) >= RESTART_DATE);
  const cohorts = [
    { label: `基准 ${baselineMonth || '（未配置）'}`, rows: base.rows },
    { label: `窗口 ${win.from}~${win.to}`, rows: win.rows },
    { label: `重启后全部（${RESTART_DATE} 起）`, rows: post },
  ];
  const kinds = ['拒信', 'HR沟通', '约面', '无'];

  const L = [];
  L.push(`# 投递复盘 ${today}（草稿）`, '');
  L.push('> 读者是 Claude。数据部分由 `npm run retro` 从 tracker 生成；解读、调整、下次问题三节在对话里和用户一起填。');
  L.push(`> 三节填完并删掉所有「${PLACEHOLDER}」标记后，这份才算完成的复盘（解除复盘线提醒、开始 14 天冷却）。`, '');
  L.push('## 触发原因', '');
  if (trigger === 'auto' && line.base?.n) {
    L.push(`复盘线触发：窗口正面回复 ${pct(line.window.pos, line.window.n)}，低于基准 ${line.base.month} ${pct(line.base.pos, line.base.n)}。`);
  } else {
    L.push(`手动运行。当前复盘线状态：${line.status}` + (line.base?.n && line.window.n ? `（窗口 ${pct(line.window.pos, line.window.n)} vs 基准 ${pct(line.base.pos, line.base.n)}）` : '') + '。');
  }
  L.push('', '## 口径', '');
  L.push(`- 数据源：\`listApplications()\`，${today} 拉取，${apps.length} 条`);
  L.push('- 样本：接触锚（`contactedAt`，历史行用 `appliedAt` 代理）满 14 天的条目（未满 14 天的不算「没回」）');
  L.push('- **正面回复** = `firstResponse` 为 HR沟通 / 约面，或 `furthestStage` 越过「未面」。**拒信不算**');
  L.push(`- 批次：基准月 = ${baselineMonth || '未配置'}；窗口 = 复盘线窗口（最近两周、满 14 天，样本 < 10 时按周往前扩，最多 6 周）；重启后全部 = ${RESTART_DATE} 起`);
  L.push(`- 方向：notes 带 \`数据Agent\` 标记的按标记；${TAG_SINCE} 之前没有标记的按岗位名 + notes 关键词粗分（标「粗分」）`);
  L.push('- 可达性 / Tier 从 report 头解析，没有就记「未标注」；单元格样本 < 5 标「样本小」');

  L.push('', '## 1. 总量', '');
  L.push(`| 批次 | 样本 | 任意回复 | 正面回复 | 回复中拒信 |`, '|---|---|---|---|---|');
  for (const c of cohorts) {
    const n = c.rows.length, any = c.rows.filter(a => responseKind(a) !== '无').length, rej = c.rows.filter(a => responseKind(a) === '拒信').length;
    L.push(`| ${c.label} | ${n} | ${n ? pct(any, n) : '—'} | ${n ? pct(c.rows.filter(isPositive).length, n) : '—'} | ${rej} |`);
  }
  L.push('', '正面回复编号：');
  for (const c of cohorts) L.push(`- ${c.label}：${nums(c.rows)}`);

  L.push('', '## 2. 分维度对比', '', '单元格 = 正面回复 `x/n (%)`。', '');
  L.push(dimTable('渠道', cohorts, a => a.channel || '未记录'), '');
  L.push(dimTable('Track', cohorts, a => a.track || 'ai-app（空）', '空 Track 按约定视为 `ai-app`（第二方向出现之前写的行）。'), '');
  L.push(dimTable('方向', cohorts, direction), '');
  L.push(dimTable('评分段', cohorts, scoreBand), '');
  L.push(dimTable('可达性', cohorts, a => parseReportHeader(a.report).reach), '');
  L.push(dimTable('Tier', cohorts, a => parseReportHeader(a.report).tier), '');
  L.push('### 回复类型', '', `| 回复类型 | ${cohorts.map(c => c.label).join(' | ')} |`, `|---|${cohorts.map(() => '---').join('|')}|`);
  for (const k of kinds) L.push(`| ${k} | ${cohorts.map(c => (c.rows.length ? `${c.rows.filter(a => responseKind(a) === k).length}/${c.rows.length}` : '—')).join(' | ')} |`);

  L.push('', '## 3. 清单', '', '### 结案候选（Contacted/Applied、无回复、接触/投递 > 14 天 —— 只列，不改）', '');
  const anchorOf = a => day(a.contactedAt || a.appliedAt);
  const stale = apps.filter(a => ['Contacted', 'Applied'].includes(a.status) && !a.firstResponseAt && !a.firstResponse && anchorOf(a) && daysBetween(anchorOf(a), today) > 14)
    .sort((x, y) => anchorOf(x).localeCompare(anchorOf(y)));
  if (!stale.length) L.push('无。');
  for (const a of stale) L.push(`- #${a.num} ${a.company} — ${a.role}（${a.channel || '渠道未记录'}，${daysBetween(anchorOf(a), today)} 天）`);

  L.push('', '### 待投队列（Evaluated 且过 fit × Tier 闸门；可达性 高>中>低>未标注，再按 Score）', '');
  const rank = { 高: 0, 中: 1, 低: 2, [UNSET]: 3 };
  const ready = apps.filter(a => a.status === 'Evaluated').map(a => ({ a, h: parseReportHeader(a.report), s: scoreOf(a) }))
    .filter(x => x.s !== null && x.s >= gateFor(x.a.track, x.h.tier))
    .sort((x, y) => rank[x.h.reach] - rank[y.h.reach] || y.s - x.s);
  if (!ready.length) L.push('无。');
  for (const { a, h, s } of ready) L.push(`- #${a.num} ${a.company} — ${a.role}｜${s}｜可达性 ${h.reach}｜${a.track || 'ai-app'}${h.tier === UNSET ? '｜Tier 未标注（按 A/B 档判）' : `｜Tier ${h.tier}`}`);

  L.push('', '## 4. 上次的待验证问题', '', previousQuestions(retros, today));
  L.push('', '## 解读', '', `（${PLACEHOLDER}）`);
  L.push('', '## 调整', '', `（${PLACEHOLDER}）`);
  L.push('', '## 下次复盘要回答的问题', '', `（${PLACEHOLDER}）`, '');
  return L.join('\n');
}

/**
 * A completed retro (no placeholder) is never overwritten — data/ is gitignored,
 * so there would be no way back. The next free `{today}-N-retro.md` is used
 * instead. Only a draft may be overwritten, and only with --force.
 */
export function writeRetro(content, { today = todayBJ(), force = false, dir = RETRO_DIR } = {}) {
  mkdirSync(dir, { recursive: true });
  for (let k = 1; ; k++) {
    const path = join(dir, k === 1 ? `${today}-retro.md` : `${today}-${k}-retro.md`);
    if (existsSync(path)) {
      if (!readFileSync(path, 'utf-8').includes(PLACEHOLDER)) continue;      // completed: keep it, try the next name
      if (!force) throw new Error(`${path} 已存在（草稿）；确认要覆盖这份草稿就加 --force`);
    }
    writeFileSync(path, content);
    return path;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const today = todayBJ();
  const md = buildRetroReport(await listApplications(), {
    today, baselineMonth: readRetroConfig().baselineMonth,
    trigger: readAlertState().active ? 'auto' : 'manual', retros: listRetros(),
  });
  if (process.argv.includes('--stdout')) { console.log(md); process.exit(0); }
  try {
    const path = writeRetro(md, { today, force: process.argv.includes('--force') });
    console.log(`✅ 复盘草稿：${path}`);
    console.log('草稿带占位标记；和 Claude 一起填完「解读 / 调整 / 下次复盘要回答的问题」并删掉标记，才算完成复盘。');
  } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
}
