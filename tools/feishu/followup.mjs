#!/usr/bin/env node
/**
 * followup.mjs — reconcile the tracker against Feishu follow-up tasks.
 *
 * The follow-up reminder used to fire only from `sync-outreach`, the one path
 * that turns Evaluated → Applied. In practice applications go out via Boss or a
 * company site and Status is changed by Claude's updateMany or by hand in the
 * Bitable UI — and Bitable has no change-event stream (`base` is not an `event`
 * domain). So the reminder never fired once. Instead of hooking every write
 * path, this script looks at the tracker as it is and makes Feishu agree with it;
 * run daily (launchd) it catches every Applied row however it got there.
 *
 * For each row that is Applied, has no first response and no exit stage:
 *   follow-up task  due appliedAt + 3d   (skipped once 14d have passed)
 *   close task      due appliedAt + 14d  → decide 「无回复」
 * A due date already in the past becomes now + 5 min, so a backlog still rings.
 *
 * Once a row gets a response, an exit stage or leaves Applied, its open tasks
 * are completed — the reminder disappears by itself.
 *
 * State: data/followup-tasks.json (gitignored) maps num → {kind: guid}. It is
 * the dedupe source; task +create's idempotency key is only a second guard.
 *
 * Run: node tools/feishu/followup.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isEnabled } from './capabilities.mjs';
import { createFollowUpTask, completeTask } from './schedule.mjs';
import { listApplications } from '../tracker-backend.mjs';

const CAREER_OPS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE = join(CAREER_OPS, 'data', 'followup-tasks.json');
const STEPS = [{ kind: 'follow-up', days: 3 }, { kind: 'close', days: 14 }];
const DUE_HOUR = '10:00:00+08:00';

const ymd = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const addDays = (dateStr, n) => ymd(new Date(new Date(`${dateStr}T12:00:00+08:00`).getTime() + n * 86400000));

function loadState() {
  if (!existsSync(STATE)) return {};
  return JSON.parse(readFileSync(STATE, 'utf8'));
}

// Feishu fires a reminder only at its due instant, so a due already in the past
// never rings. The job runs at 9:00 *machine* time, which is 21:00 Beijing on a
// US clock — "today 10:00" was already past and a whole backlog went silent.
// A past due becomes "a few minutes from now" instead.
const RING_DELAY_MS = 5 * 60000;
export function ringableDue(dueAt, now = Date.now()) {
  if (new Date(dueAt).getTime() > now + RING_DELAY_MS) return dueAt;
  return new Date(now + RING_DELAY_MS).toISOString();
}

const isPending =(r) => r.status === 'Applied' && !r.firstResponseAt && !r.exitStage;

export async function reconcileFollowUps({ dryRun = false } = {}) {
  if (!isEnabled('task')) {
    console.log('⏭  feishu.capabilities.task 未开启，跳过跟进提醒对账');
    return { skipped: true };
  }
  const state = loadState();
  const rows = await listApplications();
  const byNum = new Map(rows.map((r) => [r.num, r]));
  const today = ymd(new Date());
  const out = { created: [], completed: [], failed: [], noDate: [] };

  for (const r of rows.filter(isPending)) {
    const applied = String(r.appliedAt || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(applied)) { out.noDate.push(r.num); continue; }
    const age = Math.round((new Date(today) - new Date(applied)) / 86400000);
    const done = state[r.num] || {};
    for (const { kind, days } of STEPS) {
      if (done[kind]) continue;
      if (kind === 'follow-up' && age >= 14) continue;   // the close task covers it
      const dueAt = ringableDue(`${addDays(applied, days)}T${DUE_HOUR}`);
      const res = createFollowUpTask({
        num: r.num, company: r.company, role: r.role, days, kind, dueAt, dryRun,
      });
      if (!res.ok) { out.failed.push(`#${r.num} ${kind}: ${String(res.error).split('\n')[0]}`); continue; }
      out.created.push(`#${r.num} ${r.company} ${kind === 'close' ? '结案' : '跟进'} ${dueAt.slice(0, 16).replace('T', ' ')}`);
      if (!dryRun) (state[r.num] ||= {})[kind] = res.guid || 'created';
    }
  }

  for (const [num, tasks] of Object.entries(state)) {
    const r = byNum.get(Number(num));
    if (r && isPending(r)) continue;
    for (const [kind, guid] of Object.entries(tasks)) {
      if (guid === 'completed' || guid === 'created') continue;
      const res = completeTask(guid, dryRun);
      if (!res.ok) { out.failed.push(`#${num} 勾掉 ${kind}: ${String(res.error).split('\n')[0]}`); continue; }
      out.completed.push(`#${num} ${kind}`);
      if (!dryRun) tasks[kind] = 'completed';
    }
  }

  if (!dryRun) writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const res = await reconcileFollowUps({ dryRun });
  if (res.skipped) process.exit(0);
  const tag = dryRun ? '（dry-run，未写入）' : '';
  console.log(`[${new Date().toISOString()}] 跟进提醒对账${tag}`);
  console.log(`⏰ 新建 ${res.created.length}`); res.created.forEach((s) => console.log(`   ${s}`));
  console.log(`✔️  勾掉 ${res.completed.length}`); res.completed.forEach((s) => console.log(`   ${s}`));
  if (res.noDate.length) console.log(`⚠️  Applied 但没填投递日期，没法排提醒: #${res.noDate.join(' #')}`);
  if (res.failed.length) { console.log(`❌ 失败 ${res.failed.length}`); res.failed.forEach((s) => console.log(`   ${s}`)); process.exit(1); }
}
