#!/usr/bin/env node
/**
 * schedule.mjs — Feishu calendar + task, as an OPTIONAL career-ops capability.
 *
 * Why this exists: the 2026-07 → 2026-10 stall was not a pipeline failure. The
 * pipeline worked; 18 outreach messages went out in July and then nothing ever
 * followed up on them, because "remember to chase this in 3 days" lived only in
 * the candidate's head. Status in a table does not nudge anybody. A calendar
 * event and a task with a due date do.
 *
 * Three things get scheduled:
 *   Status → Interview  → a calendar event carrying the JD summary, company
 *                         research and question list in its description, plus a
 *                         task due 24h earlier to re-read the CV for consistency
 *                         (a standing rule of the candidate's, see memory
 *                         feedback_technical_interview_rules)
 *   Status → Applied    → a follow-up task due +3d
 *   "when are you free" → freebusy / suggestion to answer a recruiter
 *
 * ── Plugin contract ──
 * Every exported action returns one of:
 *   { ok: true,  skipped: false, ... }   did the thing
 *   { ok: true,  skipped: true, reason } capability off — CALLER MUST TREAT AS SUCCESS
 *   { ok: false, error }                 tried and failed
 *
 * career-ops is an open-source project and most users will never connect Feishu,
 * so nothing in the core flow (evaluation, tracker, PDF) may depend on this. When
 * a capability is off, every reminder is still written to data/reminders.md — a
 * degraded but real fallback, rather than silently dropping the nudge that this
 * whole module exists to deliver.
 */

import { appendFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  runLarkCli, parseJsonOut, isEnabled, skipped, resolveProfile,
  grantedScopes, missingScopes, feishuConfig,
} from './capabilities.mjs';

const CAREER_OPS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REMINDERS = join(CAREER_OPS, 'data', 'reminders.md');

// ---- degraded fallback ----

const REMINDERS_HEADER = `# Reminders（降级台账）

<!-- 当 config/profile.yml 的 feishu.capabilities.calendar / .task 未开启时，
     本该进飞书日历/任务的提醒会追加到这里，而不是静默丢掉。
     开启飞书能力后新的提醒会直接进飞书，本文件保留作为历史记录。 -->

| 写入时间 | 类型 | # | 公司 | 事项 | 到期 |
|---|---|---|---|---|---|
`;

/**
 * Append a reminder row to data/reminders.md.
 *
 * This is the whole point of the degraded path: a reminder that goes nowhere is
 * worse than no feature, because the caller believes it was recorded.
 */
function recordLocally({ kind, num, company, summary, due }) {
  try {
    if (!existsSync(dirname(REMINDERS))) mkdirSync(dirname(REMINDERS), { recursive: true });
    if (!existsSync(REMINDERS)) writeFileSync(REMINDERS, REMINDERS_HEADER);
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const cell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
    appendFileSync(REMINDERS, `| ${now} | ${kind} | ${num ?? ''} | ${cell(company)} | ${cell(summary)} | ${due ?? ''} |\n`);
    return REMINDERS;
  } catch (e) {
    // Never let bookkeeping break the caller's flow.
    console.warn(`⚠️  Could not write ${REMINDERS}: ${e.message}`);
    return null;
  }
}

function skippedButRecorded(cap, payload) {
  const res = skipped(cap);
  const path = recordLocally(payload);
  if (path) {
    console.log(`⏭  feishu.${cap} off — reminder appended to data/reminders.md instead`);
    res.recordedLocally = 'data/reminders.md';
  }
  return res;
}

// ---- helpers ----

/**
 * A description value that begins with `@` or is exactly `-` would be read by
 * lark-cli as a file reference / stdin marker, so neutralise it.
 */
function safeDescription(text) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  if (s === '-') return '​-';
  if (s.startsWith('@')) return `​${s}`;
  return s;
}

/**
 * Run a write command. `dryRun` appends lark-cli's own --dry-run, which prints
 * the request it would send and performs no outward action — the only way to
 * verify the argv for a calendar event or a chat message without actually
 * creating one in the user's tenant.
 */
function call(args, cap, dryRun = false) {
  const full = dryRun ? [...args, '--dry-run'] : args;
  try {
    const out = runLarkCli(full, { write: true, timeoutMs: 30000 });
    return { ok: true, skipped: false, dryRun, data: parseJsonOut(out)?.data ?? null, raw: out };
  } catch (e) {
    return { ok: false, skipped: false, cap, error: e.message };
  }
}

function read(args, cap) {
  try {
    const out = runLarkCli(args, { timeoutMs: 30000 });
    return { ok: true, skipped: false, data: parseJsonOut(out)?.data ?? null };
  } catch (e) {
    return { ok: false, skipped: false, cap, error: e.message };
  }
}

/**
 * Deterministic idempotency key, so re-running a sync does not create a second
 * copy of the same reminder. `task +create` takes one natively; calendar does
 * not, which is why createInterviewEvent searches before it writes.
 */
function idemKey(kind, num, extra = '') {
  return `career-ops:${kind}:${num}${extra ? ':' + extra : ''}`;
}

// ---- actions ----

/**
 * Create the interview event, and the 24h-before CV consistency task with it.
 *
 * Guards against duplicates by searching for an existing event with the same
 * title in a window around the start time: Status can move to Interview more
 * than once (one round per stage), and nobody wants five identical events.
 */
export function createInterviewEvent({
  num, company, role, start, end, description = '', attendeeIds = [], calendarId, dryRun = false,
}) {
  if (!start) return { ok: false, error: 'start is required (ISO 8601)' };
  const summary = `面试｜${company}｜${role}${num ? `（#${num}）` : ''}`;
  const endTime = end || new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();

  if (!isEnabled('calendar')) {
    return skippedButRecorded('calendar', {
      kind: '面试', num, company, summary: `${role} @ ${start}`, due: start.slice(0, 16),
    });
  }

  const dup = dryRun ? { ok: false } : read(['calendar', '+search-event', '--query', summary], 'calendar');
  const found = dup.ok && (dup.data?.items || dup.data?.events || []).length > 0;
  if (found) {
    return { ok: true, skipped: false, duplicate: true, summary,
             note: 'An event with this title already exists; not creating a second one.' };
  }

  const args = ['calendar', '+create', '--summary', summary, '--start', start, '--end', endTime];
  if (calendarId) args.push('--calendar-id', calendarId);
  if (attendeeIds.length) args.push('--attendee-ids', attendeeIds.join(','));
  // The description is the actual payload: --description takes Markdown, so the
  // JD summary, company research and question list ride along into the event and
  // are there on the phone 10 minutes before the call. Feishu doc URLs inside it
  // auto-render as doc-mention chips.
  const desc = safeDescription(description);
  if (desc) args.push('--description', desc);

  const result = call(args, 'calendar', dryRun);
  if (!result.ok) return result;

  const prep = createPreInterviewCheck({ num, company, role, interviewStart: start, dryRun });
  return { ...result, summary, preInterviewTask: prep };
}

/**
 * Task due 24h before the interview: re-read the CV against what was actually
 * sent. This encodes one of the candidate's standing interview rules rather than
 * inventing a new process.
 */
export function createPreInterviewCheck({ num, company, role, interviewStart, dryRun = false }) {
  const due = new Date(new Date(interviewStart).getTime() - 24 * 60 * 60 * 1000).toISOString();
  const summary = `面试前过简历一致性｜${company}｜${role}${num ? `（#${num}）` : ''}`;
  const description =
    `面试前 24h 检查（见 modes/_shared.md 与面试铁律）：\n`
    + `1. 过一遍投出去的那版 PDF（output/ 里带 track 后缀的那份），确认口头讲的和纸上写的一致\n`
    + `2. 准备好 gap 期话术（config/profile.yml 的 narrative.exit_story）\n`
    + `3. 想好结尾要反问的那 1 个问题\n`
    + (num ? `4. 复习评估报告 reports/ 里的 #${num}\n` : '');

  if (!isEnabled('task')) {
    return skippedButRecorded('task', { kind: '面试前检查', num, company, summary, due: due.slice(0, 16) });
  }

  return call([
    'task', '+create',
    '--summary', summary,
    '--description', safeDescription(description),
    '--due', due,
    '--idempotency-key', idemKey('pre-interview', num, interviewStart.slice(0, 10)),
  ], 'task', dryRun);
}

/**
 * Follow-up task after an application goes out. Default +3d matches the Boss
 * follow-up cadence in modes/contact.md (3-5 days, don't spam).
 *
 * ⚠️ `task +create --due` is documented as accepting `relative:+2d`, and it does
 * NOT — the parser rejects it with "failed to parse due time" and only takes
 * ISO 8601 or a Unix timestamp. Caught by a --dry-run; the help text is wrong.
 * So the date is computed here.
 */
export function createFollowUpTask({ num, company, role, days = 3, dueAt = null, kind = 'follow-up', note = '', dryRun = false }) {
  const tag = `${company}｜${role}${num ? `（#${num}）` : ''}`;
  const due = dueAt || new Date(Date.now() + days * 86400000).toISOString();
  const [summary, description] = kind === 'close'
    ? [`结案？投递 14 天无回复｜${tag}`,
      `投出去 14 天没有任何回复（历史上 80% 的回复在 6 天内到）。\n`
      + `还没回 → 告诉 Claude「#${num} 无回复结案」，会标 Discarded + exitStage=无回复。\n`
      + `其实回复了 → 告诉 Claude 记首次回复，这条任务会被自动勾掉。\n`]
    : [`跟进｜${tag}`,
      `投出去 ${days} 天还没回音就发一条 follow-up（≤60 字，给 HR 台阶，顺手筛掉僵尸岗）。\n`
      + `话术框架见 modes/contact.md 的「消息 3」。\n`
      + `收到回复后告诉 Claude 记首次回复，后续提醒会自动勾掉。\n`];
  const fullDescription = description + (note ? `\n备注：${note}\n` : '');

  if (!isEnabled('task')) {
    return skippedButRecorded('task', { kind: kind === 'close' ? '结案' : '跟进', num, company, summary, due: due.slice(0, 10) });
  }

  const args = [
    'task', '+create',
    '--summary', summary,
    '--description', safeDescription(fullDescription),
    '--due', due,
    '--idempotency-key', idemKey(kind, num),
  ];
  // Without an assignee the task is merely "created by me", and Feishu raises
  // no due-date notification for it — the reminder would never be seen.
  const self = feishuConfig().config?.self_open_id;
  if (self) args.push('--assignee', self);
  const res = call(args, 'task', dryRun);
  const guid = res.data?.guid || res.data?.task?.guid;
  if (res.ok && guid && !dryRun) {
    const rem = call(['task', '+reminder', '--task-id', guid, '--set', '0m'], 'task');
    if (!rem.ok) console.warn(`⚠️  #${num} 任务已建，但到期提醒没设上: ${rem.error.split('\n')[0]}`);
  }
  return { ...res, guid };
}

/** Tick off a reminder that is no longer needed (a reply came in, or the process ended). */
export function completeTask(guid, dryRun = false) {
  if (!isEnabled('task')) return skipped('task');
  return call(['task', '+complete', '--task-id', guid], 'task', dryRun);
}

/**
 * Answer "when are you free?" — the one recruiter question that reliably costs a
 * day of latency. Returns suggested blocks; picking one is still the user's call.
 */
export function suggestSlots({ start, end, durationMin = 60 }) {
  if (!isEnabled('calendar')) return skipped('calendar', 'cannot read free/busy');
  const args = ['calendar', '+suggestion'];
  if (start) args.push('--start', start);
  if (end) args.push('--end', end);
  if (durationMin) args.push('--duration', String(durationMin));
  const res = read(args, 'calendar');
  if (res.ok) return res;
  // +suggestion takes a loose time range and its flags vary by CLI version;
  // freebusy is the stable primitive, so fall back to it rather than failing.
  return read(['calendar', '+freebusy', '--start', start, '--end', end], 'calendar');
}

export function todayAgenda() {
  if (!isEnabled('calendar')) return skipped('calendar');
  return read(['calendar', '+agenda'], 'calendar');
}

export function myOpenTasks() {
  if (!isEnabled('task')) return skipped('task');
  return read(['task', '+get-my-tasks'], 'task');
}

/**
 * Report whether the configured profile already holds the scopes these actions
 * need. Read-only on purpose: `auth login` opens a QR flow only the user can
 * complete, so this names what is missing and stops.
 *
 * Checks exact scope strings, not domain prefixes — the `task` domain spans ten
 * scopes and only `task:task:write` lets you create one, so a prefix check would
 * call a token "granted" that then fails at write time.
 */
export function checkScopes() {
  const profile = resolveProfile();
  const granted = grantedScopes();
  if (!granted.ok) {
    return { profile, ok: false, error: granted.error || 'identity unavailable' };
  }
  const out = { profile, ok: true, capabilities: {} };
  for (const cap of ['calendar', 'task']) {
    const miss = missingScopes(cap, granted.scopes);
    out.capabilities[cap] = { ok: miss.length === 0, missing: miss };
  }
  return out;
}
