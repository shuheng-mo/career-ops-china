#!/usr/bin/env node
/**
 * events.mjs — one row per contact/submission event, rolled up onto Applications.
 *
 * `Status` + `Applied At` answer "where is this row now", but they flatten
 * history: a Boss greeting, a headhunter contact and a confirmed resume
 * submission all used to land in the same `Applied`. This table keeps the
 * sequence — every event its own row (date, type, channel, confidence) — and
 * rolls the extremes up onto the application so the two funnels
 * (contact / submitted) never need to read this table:
 *   - earliest 接触类 event → Contacted At (+ Contact Type)
 *   - earliest 提交类 event → Submitted At (+ Submission Evidence; 高置信不被低置信覆盖)
 *   - Status only ever moves FORWARD (Evaluated→Contacted→Applied); terminal
 *     rows record the event and are left untouched.
 *
 * Storage: a Bitable table under tracker.bitable.table_id_events (created on
 * first use, id written back to profile.yml). md backend falls back to
 * data/events.jsonl, same as interviews.mjs.
 *
 * CLI:
 *   node tools/feishu/events.mjs add <num> <事件> <YYYY-MM-DD> [--channel Boss] [--confidence 高] [--evidence "..."] [--company X] [--no-rollup]
 *   node tools/feishu/events.mjs list [<num>]
 *   node tools/feishu/events.mjs setup
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  CAREER_OPS, readProfileTracker, listApplications, updateMany, isTerminal,
  CHANNELS, EVENT_TYPES, CONTACT_EVENT_TYPES, SUBMISSION_EVENT_TYPES,
  CONFIDENCE_LEVELS, HIGH_CONFIDENCE_EVIDENCE,
} from '../tracker-backend.mjs';
import { runLarkCli, parseJsonOut } from './capabilities.mjs';

const PROFILE_PATH = join(CAREER_OPS, 'config', 'profile.yml');
const JSONL_PATH = join(CAREER_OPS, 'data', 'events.jsonl');
const TABLE_NAME = 'Events';

const sel = (name, options, hue) => ({
  type: 'select', name, multiple: false,
  options: options.map(o => ({ name: o, hue: typeof hue === 'function' ? hue(o) : hue, lightness: 'Light' })),
});

function fieldsJson() {
  return [
    { type: 'number', name: 'Num', style: { type: 'plain', precision: 0, thousands_separator: false } },
    { type: 'text', name: 'Company', style: { type: 'plain' } },
    sel('Event', EVENT_TYPES, e => (
      SUBMISSION_EVENT_TYPES.has(e) ? 'Green'
        : CONTACT_EVENT_TYPES.has(e) ? 'Blue'
          : e.startsWith('回复-') ? 'Turquoise' : 'Gray'
    )),
    { type: 'datetime', name: 'Date', style: { format: 'yyyy-MM-dd' } },
    sel('Channel', CHANNELS, 'Wathet'),
    sel('Confidence', CONFIDENCE_LEVELS, c => ({ 高: 'Green', 中: 'Yellow', 低: 'Gray' })[c]),
    // Free-text pointer to the verifiable evidence: "outreach/852-...md", "Boss 聊天记录截图",
    // "猎头微信：已推荐给 HSBC hiring manager"…
    { type: 'text', name: 'Evidence', style: { type: 'plain' } },
  ];
}

const isBitable = () => (readProfileTracker().backend || 'md') === 'bitable';

/** Table id, creating the table (and recording its id in profile.yml) on first use. */
export function ensureTable() {
  const cfg = readProfileTracker();
  const appToken = cfg.bitable?.app_token;
  if (!appToken) throw new Error('tracker.bitable.app_token 未配置');
  if (cfg.bitable?.table_id_events) return { appToken, tableId: cfg.bitable.table_id_events };

  const out = parseJsonOut(runLarkCli([
    'base', '+table-create', '--base-token', appToken, '--name', TABLE_NAME,
    '--fields', JSON.stringify(fieldsJson()), '--view', JSON.stringify([{ name: 'All', type: 'grid' }]),
  ], { write: true, timeoutMs: 60000 }));
  const t = out?.table || out?.data?.table || out?.data || out;
  const tableId = t?.table_id || t?.id;
  if (!tableId) throw new Error(`could not read table_id from +table-create: ${JSON.stringify(out).slice(0, 300)}`);

  // Line edit, not a YAML rewrite — profile.yml is hand-commented (same as interviews.mjs).
  const yml = readFileSync(PROFILE_PATH, 'utf-8');
  const line = `    table_id_events: "${tableId}"            # 接触/投递事件表（tools/feishu/events.mjs 自动建）\n`;
  const next = /^\s*table_id_events:.*$/m.test(yml)
    ? yml.replace(/^\s*table_id_events:.*\n/m, line)
    : yml.replace(/^(\s*table_id_interviews:.*\n)/m, `$1${line}`);
  if (next === yml) throw new Error(`建好了表 ${tableId}，但没能写回 profile.yml —— 手动加 table_id_events`);
  writeFileSync(PROFILE_PATH, next);
  return { appToken, tableId };
}

export async function listEvents(num) {
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
        const f = Object.fromEntries(names.map((n, j) => [n, r[j]]));
        const one = v => (Array.isArray(v) ? v[0] || '' : v || '');
        const date = typeof f.Date === 'number' ? new Date(f.Date).toISOString().slice(0, 10) : String(f.Date || '').slice(0, 10);
        rows.push({
          num: Number(f.Num), company: f.Company || '', event: one(f.Event), date,
          channel: one(f.Channel), confidence: one(f.Confidence), evidence: f.Evidence || '',
          _recordId: d.record_id_list?.[i],
        });
      });
      if (!d.has_more || !(d.data || []).length) break;
    }
  }
  return (num ? rows.filter(r => r.num === Number(num)) : rows)
    .sort((a, b) => a.num - b.num || (a.date || '').localeCompare(b.date || ''));
}

// Event type → the Contact Type it establishes (channel refines 打招呼).
function contactTypeOf(event, channel) {
  if (event === '猎头接触') return '猎头接触';
  if (event === '内推请求') return '内推请求';
  if (event === '打招呼') return channel === 'Boss' ? 'Boss打招呼' : channel === '官网' ? '官网留言' : '其他';
  return '';
}

// Event type → the Submission Evidence it establishes. Empty for non-submission events.
function evidenceOf(event) {
  return {
    发送简历: '简历已发对方',
    系统提交: '系统提交确认',
    客户确认收到: '客户确认收到',
    猎头推荐: '猎头称已推荐',
  }[event] || '';
}

/**
 * Compute the main-table rollup for one event against one application row.
 * Pure — the tests drive it directly without Bitable.
 *
 * Invariants: never overwrite a non-empty stored value except to move a date
 * EARLIER (first contact/submission wins) or to raise evidence confidence
 * (低→高). Status only advances. Terminal rows: no rollup.
 */
export function rollupFor(app, ev) {
  if (isTerminal(app.status)) return null;
  const upd = {};
  if (CONTACT_EVENT_TYPES.has(ev.event)) {
    if (!app.contactedAt || (ev.date && ev.date < app.contactedAt)) {
      upd.contactedAt = ev.date;
      const ct = contactTypeOf(ev.event, ev.channel);
      if (ct) upd.contactType = ct;
    }
    if (app.status === 'Evaluated') upd.status = 'Contacted';
    if (ev.channel && !app.channel) upd.channel = ev.channel;
  }
  if (SUBMISSION_EVENT_TYPES.has(ev.event)) {
    if (!app.submittedAt || (ev.date && ev.date < app.submittedAt)) {
      upd.submittedAt = ev.date;
    }
    // 证据等级独立于日期：高置信不被低置信覆盖；空→任意、低→高、高→高 可写
    const newEv = evidenceOf(ev.event);
    if (newEv) {
      const oldHigh = HIGH_CONFIDENCE_EVIDENCE.has(app.submissionEvidence);
      const newHigh = HIGH_CONFIDENCE_EVIDENCE.has(newEv);
      if (!app.submissionEvidence || !oldHigh || newHigh) {
        upd.submissionEvidence = newEv;
      }
    }
    if (app.status === 'Evaluated' || app.status === 'Contacted') {
      upd.status = 'Applied';
      // 双写约定（2026-11-18 起）：确认提交时 appliedAt=Submitted At；历史
      // appliedAt 已有值的行不动（旧口径含义冻结）。只填空，绝不改写。
      if (!app.appliedAt && ev.date) upd.appliedAt = ev.date;
    }
  }
  // 回复类事件只补空的 firstResponse，不覆盖既有记录（面试轮次的滚回在 interviews.mjs）
  if (ev.event === '回复-HR沟通' && !app.firstResponse) { upd.firstResponse = 'HR沟通'; if (!app.firstResponseAt && ev.date) upd.firstResponseAt = ev.date; }
  if (ev.event === '回复-约面' && !app.firstResponse) { upd.firstResponse = '约面'; if (!app.firstResponseAt && ev.date) upd.firstResponseAt = ev.date; }
  if (ev.event === '回复-拒信' && !app.firstResponse) { upd.firstResponse = '拒信'; if (!app.firstResponseAt && ev.date) upd.firstResponseAt = ev.date; }
  return Object.keys(upd).length ? upd : null;
}

/**
 * Record one event and roll it up onto the application.
 * @param {{num, event, date, channel?, confidence?, evidence?, company?}} r
 * @param {{rollup?: boolean}} opts  rollup:false for bulk backfills that set
 *                                   the application fields themselves.
 */
export async function addEvent(r, { rollup = true } = {}) {
  if (!EVENT_TYPES.includes(r.event)) throw new Error(`事件「${r.event}」不合法：${EVENT_TYPES.join(' / ')}`);
  if (r.channel && !CHANNELS.includes(r.channel)) throw new Error(`渠道「${r.channel}」不合法：${CHANNELS.join(' / ')}`);
  if (r.confidence && !CONFIDENCE_LEVELS.includes(r.confidence)) throw new Error(`置信度「${r.confidence}」不合法：${CONFIDENCE_LEVELS.join(' / ')}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) throw new Error(`日期要 YYYY-MM-DD：${r.date}`);

  const apps = await listApplications();
  const app = apps.find(a => a.num === Number(r.num));
  if (!app) throw new Error(`tracker 里没有 #${r.num}`);
  const company = r.company || app.company;

  if (!isBitable()) {
    appendFileSync(JSONL_PATH, JSON.stringify({
      num: Number(r.num), company, event: r.event, date: r.date,
      channel: r.channel || '', confidence: r.confidence || '', evidence: r.evidence || '',
    }) + '\n');
  } else {
    const { appToken, tableId } = ensureTable();
    const f = { Num: Number(r.num), Company: company, Event: r.event, Date: `${r.date} 00:00:00` };
    if (r.channel) f.Channel = r.channel;
    if (r.confidence) f.Confidence = r.confidence;
    if (r.evidence) f.Evidence = r.evidence;
    // One row per (num, event, date): re-recording corrects instead of duplicating.
    const prev = (await listEvents(r.num)).find(x => x.event === r.event && x.date === r.date);
    const args = ['base', '+record-upsert', '--base-token', appToken, '--table-id', tableId, '--json', JSON.stringify(f)];
    if (prev?._recordId) args.splice(6, 0, '--record-id', prev._recordId);
    runLarkCli(args, { write: true });
  }

  if (!rollup) return { app, rolled: null };
  const upd = rollupFor(app, r);
  if (!upd) return { app, rolled: null };
  await updateMany([{ num: app.num, ...upd }]);
  return { app, rolled: upd };
}

// ---- CLI ----
if (process.argv[1] && process.argv[1].endsWith('events.mjs')) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = k => { const i = rest.indexOf(`--${k}`); return i > -1 ? rest[i + 1] : undefined; };
  const pos = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] || '').startsWith('--'));

  if (cmd === 'setup') {
    console.log(ensureTable());
  } else if (cmd === 'list') {
    for (const r of await listEvents(pos[0])) {
      console.log(`#${r.num} ${r.company} | ${r.date} ${r.event}${r.channel ? `（${r.channel}）` : ''}${r.confidence ? ` [${r.confidence}]` : ''}${r.evidence ? ` | ${r.evidence}` : ''}`);
    }
  } else if (cmd === 'add') {
    const [num, event, date] = pos;
    const res = await addEvent({
      num, event, date,
      channel: opt('channel'), confidence: opt('confidence'),
      evidence: opt('evidence'), company: opt('company'),
    }, { rollup: !process.argv.includes('--no-rollup') });
    console.log(`✅ #${num} ${res.app.company} ${event} ${date}` + (res.rolled ? `；主表 → ${JSON.stringify(res.rolled)}` : ''));
  } else {
    console.log('用法：\n  node tools/feishu/events.mjs add <num> <事件> <YYYY-MM-DD> [--channel Boss] [--confidence 高] [--evidence "..."] [--no-rollup]\n  node tools/feishu/events.mjs list [<num>]\n  node tools/feishu/events.mjs setup'
      + `\n事件：${EVENT_TYPES.join(' / ')}\n渠道：${CHANNELS.join(' / ')}　置信度：${CONFIDENCE_LEVELS.join(' / ')}`);
  }
}
