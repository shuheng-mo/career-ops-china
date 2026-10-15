#!/usr/bin/env node
/**
 * interviews.mjs — one row per interview round, and the roll-up onto Applications.
 *
 * The Applications row answers "how far did this process get and where did it
 * end" (Furthest Stage / Exit Stage). That is enough for the funnel, but not for
 * fixing anything: "failed at 二面" twice is only useful once you can see it was
 * the system-design round both times. So every round gets its own row here —
 * date, format, result, and what the interviewer actually said.
 *
 * Writing a round also rolls it up onto the application, so the two never drift:
 *   - Furthest Stage = the furthest round seen so far
 *   - result 挂      → Exit Stage "<round>挂", Status Rejected
 *   - otherwise      → Status Interview (unless already terminal)
 *
 * Storage: a second Bitable table under tracker.bitable.table_id_interviews
 * (created on first use and written back to profile.yml). On the md backend it
 * falls back to data/interviews.jsonl, so the open-source path keeps working.
 *
 * CLI:
 *   node tools/feishu/interviews.mjs add <num> <轮次> <YYYY-MM-DD> <结果> [--format 视频] [--feedback "..."] [--company X]
 *   node tools/feishu/interviews.mjs list [<num>]
 *   node tools/feishu/interviews.mjs setup            # create the table only
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  CAREER_OPS, readProfileTracker, listApplications, updateMany, isTerminal,
  INTERVIEW_STAGES, ROUND_RESULTS, ROUND_FORMATS,
} from '../tracker-backend.mjs';
import { runLarkCli, parseJsonOut } from './capabilities.mjs';

const PROFILE_PATH = join(CAREER_OPS, 'config', 'profile.yml');
const JSONL_PATH = join(CAREER_OPS, 'data', 'interviews.jsonl');
const TABLE_NAME = 'Interviews';

// Rounds are a subset of INTERVIEW_STAGES: '未面' and 'Offer' are outcomes, not rounds.
export const ROUNDS = INTERVIEW_STAGES.filter(s => s !== '未面' && s !== 'Offer');

const sel = (name, options, hue) => ({
  type: 'select', name, multiple: false,
  options: options.map(o => ({ name: o, hue: typeof hue === 'function' ? hue(o) : hue, lightness: 'Light' })),
});

function fieldsJson() {
  return [
    { type: 'number', name: 'Num', style: { type: 'plain', precision: 0, thousands_separator: false } },
    { type: 'text', name: 'Company', style: { type: 'plain' } },
    sel('Round', ROUNDS, 'Yellow'),
    { type: 'datetime', name: 'Date', style: { format: 'yyyy-MM-dd' } },
    sel('Format', ROUND_FORMATS, 'Blue'),
    sel('Result', ROUND_RESULTS, r => ({ 通过: 'Green', 挂: 'Red', 待定: 'Gray', 取消: 'Gray' })[r]),
    // The point of the table. Verbatim where possible: "面试官说系统设计深度不够"
    // is actionable, "感觉一般" is not.
    { type: 'text', name: 'Feedback', style: { type: 'plain' } },
  ];
}

const isBitable = () => (readProfileTracker().backend || 'md') === 'bitable';

/** Table id, creating the table (and recording its id in profile.yml) on first use. */
export function ensureTable() {
  const cfg = readProfileTracker();
  const appToken = cfg.bitable?.app_token;
  if (!appToken) throw new Error('tracker.bitable.app_token 未配置');
  if (cfg.bitable?.table_id_interviews) return { appToken, tableId: cfg.bitable.table_id_interviews };

  const out = parseJsonOut(runLarkCli([
    'base', '+table-create', '--base-token', appToken, '--name', TABLE_NAME,
    '--fields', JSON.stringify(fieldsJson()), '--view', JSON.stringify([{ name: 'All', type: 'grid' }]),
  ], { write: true, timeoutMs: 60000 }));
  const t = out?.table || out?.data?.table || out?.data || out;
  const tableId = t?.table_id || t?.id;
  if (!tableId) throw new Error(`could not read table_id from +table-create: ${JSON.stringify(out).slice(0, 300)}`);

  // Record it next to table_id_applications. A line edit, not a YAML rewrite:
  // profile.yml is hand-commented and a round-trip through a YAML library would
  // throw every comment away.
  const yml = readFileSync(PROFILE_PATH, 'utf-8');
  const line = `    table_id_interviews: "${tableId}"           # 面试轮次表（tools/feishu/interviews.mjs 自动建）\n`;
  const next = /^\s*table_id_interviews:.*$/m.test(yml)
    ? yml.replace(/^\s*table_id_interviews:.*\n/m, line)
    : yml.replace(/^(\s*table_id_applications:.*\n)/m, `$1${line}`);
  if (next === yml) throw new Error(`建好了表 ${tableId}，但没能写回 profile.yml —— 手动加 table_id_interviews`);
  writeFileSync(PROFILE_PATH, next);
  return { appToken, tableId };
}

export async function listRounds(num) {
  let rows;
  if (!isBitable()) {
    rows = existsSync(JSONL_PATH)
      ? readFileSync(JSONL_PATH, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
  } else {
    const { appToken, tableId } = ensureTable();
    rows = [];
    for (let offset = 0; ; offset += 100) {
      const d = parseJsonOut(runLarkCli([
        'base', '+record-list', '--base-token', appToken, '--table-id', tableId,
        '--limit', '100', '--offset', String(offset),
      ]))?.data || {};
      const names = d.fields || [];
      (d.data || []).forEach((r, i) => {
        const f = Object.fromEntries(names.map((n, i) => [n, r[i]]));
        const one = v => (Array.isArray(v) ? v[0] || '' : v || '');
        const date = typeof f.Date === 'number' ? new Date(f.Date).toISOString().slice(0, 10) : String(f.Date || '').slice(0, 10);
        rows.push({ num: Number(f.Num), company: f.Company || '', round: one(f.Round), date, format: one(f.Format), result: one(f.Result), feedback: f.Feedback || '', _recordId: d.record_id_list?.[i] });
      });
      if (!d.has_more || !(d.data || []).length) break;
    }
  }
  return (num ? rows.filter(r => r.num === Number(num)) : rows)
    .sort((a, b) => a.num - b.num || (a.date || '').localeCompare(b.date || '') || ROUNDS.indexOf(a.round) - ROUNDS.indexOf(b.round));
}

/**
 * Record one round and roll it up onto the application.
 * @param {{num, round, date, result, format?, feedback?, company?}} r
 * @param {{rollup?: boolean}} opts  rollup:false for bulk backfills that set
 *                                   the application fields themselves.
 */
export async function addRound(r, { rollup = true } = {}) {
  if (!ROUNDS.includes(r.round)) throw new Error(`轮次「${r.round}」不合法：${ROUNDS.join(' / ')}`);
  if (!ROUND_RESULTS.includes(r.result)) throw new Error(`结果「${r.result}」不合法：${ROUND_RESULTS.join(' / ')}`);
  if (r.format && !ROUND_FORMATS.includes(r.format)) throw new Error(`形式「${r.format}」不合法：${ROUND_FORMATS.join(' / ')}`);
  // Date may be empty only for backfilled history where it was never recorded.
  if (r.date && !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw new Error(`日期要 YYYY-MM-DD：${r.date}`);
  if (!r.date && rollup) throw new Error('新记录必须带日期 YYYY-MM-DD');

  const apps = await listApplications();
  const app = apps.find(a => a.num === Number(r.num));
  if (!app) throw new Error(`tracker 里没有 #${r.num}`);
  const company = r.company || app.company;

  if (!isBitable()) {
    appendFileSync(JSONL_PATH, JSON.stringify({ num: Number(r.num), company, round: r.round, date: r.date || '', format: r.format || '', result: r.result, feedback: r.feedback || '' }) + '\n');
  } else {
    const { appToken, tableId } = ensureTable();
    const f = { Num: Number(r.num), Company: company, Round: r.round, Result: r.result };
    if (r.date) f.Date = `${r.date} 00:00:00`;
    if (r.format) f.Format = r.format;
    if (r.feedback) f.Feedback = r.feedback;
    // One row per (num, round): re-recording a round corrects it instead of
    // adding a duplicate — e.g. a 待定 that later turned into 挂.
    const prev = (await listRounds(r.num)).find(x => x.round === r.round);
    const args = ['base', '+record-upsert', '--base-token', appToken, '--table-id', tableId, '--json', JSON.stringify(f)];
    if (prev?._recordId) args.splice(6, 0, '--record-id', prev._recordId);
    runLarkCli(args, { write: true });
  }

  if (!rollup) return { app, rolled: null };

  const upd = { num: app.num };
  const cur = INTERVIEW_STAGES.indexOf(app.furthestStage);
  if (INTERVIEW_STAGES.indexOf(r.round) > cur) upd.furthestStage = r.round;
  if (!app.firstResponse) { upd.firstResponse = '约面'; if (!app.firstResponseAt) upd.firstResponseAt = r.date; }
  if (r.result === '挂') {
    upd.exitStage = `${r.round}挂`;
    upd.status = 'Rejected';
  } else if (!isTerminal(app.status) && r.result !== '取消') {
    upd.status = 'Interview';
  }
  await updateMany([upd]);
  return { app, rolled: upd };
}

// ---- CLI ----
if (process.argv[1] && process.argv[1].endsWith('interviews.mjs')) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = k => { const i = rest.indexOf(`--${k}`); return i > -1 ? rest[i + 1] : undefined; };
  const pos = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] || '').startsWith('--'));

  if (cmd === 'setup') {
    console.log(ensureTable());
  } else if (cmd === 'list') {
    for (const r of await listRounds(pos[0])) {
      console.log(`#${r.num} ${r.company} | ${r.date} ${r.round}（${r.format || '—'}）→ ${r.result}${r.feedback ? ` | ${r.feedback}` : ''}`);
    }
  } else if (cmd === 'add') {
    const [num, round, date, result] = pos;
    const res = await addRound({ num, round, date, result, format: opt('format'), feedback: opt('feedback'), company: opt('company') });
    console.log(`✅ #${num} ${res.app.company} ${round} ${result}` + (res.rolled ? `；主表 → ${JSON.stringify(res.rolled)}` : ''));
  } else {
    console.log('用法：\n  node tools/feishu/interviews.mjs add <num> <轮次> <YYYY-MM-DD> <结果> [--format 视频] [--feedback "..."]\n  node tools/feishu/interviews.mjs list [<num>]\n  node tools/feishu/interviews.mjs setup'
      + `\n轮次：${ROUNDS.join(' / ')}　结果：${ROUND_RESULTS.join(' / ')}　形式：${ROUND_FORMATS.join(' / ')}`);
  }
}
