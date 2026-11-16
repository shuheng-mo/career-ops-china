#!/usr/bin/env node
/**
 * retro-alert.mjs — the must-arrive alert for the 复盘线 (retro trigger line).
 *
 * Runs every morning from the 9:00 launchd job (tools/feishu/followup.mjs calls
 * runRetroCheck() before it reconciles follow-up tasks). When the line is below
 * the baseline and no completed retro exists since the round began, it:
 *
 *   1. sends its OWN bot message — not a task, not a line in the digest. Follow-up
 *      tasks are about chasing single applications; a retro means "stop sending",
 *      which outranks all of them, so it must not sit in the same list.
 *   2. buzzes that message (应用内加急). A buzz stays on screen until acknowledged —
 *      the one Feishu signal stronger than any calendar or task reminder.
 *   3. falls back to a macOS notification + data/reminders.md whenever Feishu is
 *      switched off or any step fails, so the alert arrives one way or another.
 *
 * State-based: it fires every day until a completed retro appears (see
 * decideAlert in tools/retro-core.mjs), never twice on the same day.
 *
 * Switch: feishu.capabilities.retro_alert — separate from im_card on purpose, so
 * muting the digest does not mute this.
 *
 * Run alone: node tools/feishu/retro-alert.mjs [--dry-run]
 */

import { appendFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { runLarkCli, parseJsonOut, isEnabled, feishuConfig } from './capabilities.mjs';
import { listApplications } from '../tracker-backend.mjs';
import {
  CAREER_OPS, todayBJ, retroLine, readRetroConfig, listRetros,
  readAlertState, writeAlertState, decideAlert,
} from '../retro-core.mjs';

const pct = (pos, n) => `${pos}/${n} (${n ? Math.round((pos / n) * 100) : 0}%)`;

export function renderAlert(line, streak) {
  const w = line.window, b = line.base;
  return [
    `## 🟥 复盘线触发（第 ${streak} 天）`,
    '',
    `- 近两周投递（${w.from} ~ ${w.to}，均已满 14 天）正面回复 **${pct(w.pos, w.n)}**`,
    `- 基准 ${b.month}：**${pct(b.pos, b.n)}**`,
    '- 正面回复 = HR沟通 / 约面；拒信不算',
    '',
    '**先停止加量投递。** 下一步：`npm run retro` 生成复盘草稿，和 Claude 一起填完「解读 / 调整 / 下次复盘要回答的问题」三节并删掉占位标记 —— 只生成草稿不会解除这条提醒。',
  ].join('\n');
}

const selfOpenId = () => feishuConfig().config?.self_open_id || '';

function sendMessage(body, today) {
  const openId = selfOpenId();
  if (!openId) throw new Error('feishu.config.self_open_id is not set in config/profile.yml');
  // as: 'bot' — a user-identity send lands in the silent self-chat (see notify.mjs header).
  const out = runLarkCli([
    'im', '+messages-send', '--user-id', openId, '--markdown', body,
    '--idempotency-key', `career-ops:retro:bot:${today}`,
  ], { write: true, as: 'bot', timeoutMs: 30000 });
  const id = parseJsonOut(out)?.data?.message_id;
  if (!id) throw new Error(`lark-cli returned no message_id: ${String(out).slice(0, 300)}`);
  return { messageId: id };
}

const urgentArgs = (messageId) => [
  'im', 'messages', 'urgent_app',
  '--message-id', messageId, '--user-id-type', 'open_id',
  '--data', JSON.stringify({ user_id_list: [selfOpenId()] }),
];

function sendUrgent(messageId) {
  runLarkCli(urgentArgs(messageId), { write: true, as: 'bot', timeoutMs: 30000 });
}

function notifyLocal(title, text) {
  const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFileSync('osascript', ['-e', `display notification "${q(text)}" with title "${q(title)}" sound name "Glass"`]);
}

function appendReminder(line) {
  appendFileSync(join(CAREER_OPS, 'data', 'reminders.md'), `${line}\n`);
}

const defaultDeps = () => ({
  feishuOn: (() => { try { return isEnabled('retro_alert'); } catch { return false; } })(),
  stateIO: { read: () => readAlertState(), write: (s) => writeAlertState(s) },
  retros: listRetros(),
  baselineMonth: readRetroConfig().baselineMonth,
  sendMessage, sendUrgent, notifyLocal, appendReminder,
});

const SCOPE_HINT = '加急可能缺 scope（im:message.urgent / im:message.urgent:app_send）：先 `lark-cli auth scopes --profile <p>` 看 app 侧是否开通，再按 CLAUDE.md「新增 scope 的流程」交给用户授权';

export async function runRetroCheck({ dryRun = false, today = todayBJ(), apps, deps: over = {} } = {}) {
  const deps = { ...defaultDeps(), ...over };
  const rows = apps || await listApplications();
  const line = retroLine(rows, { today, baselineMonth: deps.baselineMonth });
  const state = deps.stateIO.read();
  const d = decideAlert({ line, retros: deps.retros, state, today });
  const res = { action: d.action, streak: d.streak, line, feishu: 'skipped', urgent: 'skipped', local: false, errors: [] };

  if (d.action !== 'alert') {
    if (!dryRun && d.action !== 'already-sent') deps.stateIO.write(d.state);
    return res;
  }

  const body = renderAlert(line, d.streak);
  if (dryRun) { res.body = body; res.urgentArgs = urgentArgs('<message_id>'); return res; }

  const next = { ...d.state };
  let fallback = false;
  if (!deps.feishuOn) {
    fallback = true;
  } else {
    try {
      const { messageId } = await deps.sendMessage(body, today);
      res.feishu = 'sent'; next.messageId = messageId;
      try { await deps.sendUrgent(messageId); res.urgent = 'sent'; }
      catch (e) {
        res.urgent = 'failed'; fallback = true; res.errors.push(`加急失败：${e.message}`);
        if (/scope|permission|99991672|99991679|230/.test(e.message)) res.errors.push(SCOPE_HINT);
      }
    } catch (e) {
      res.feishu = 'failed'; fallback = true; res.errors.push(`飞书消息发送失败：${e.message}`);
    }
  }

  if (fallback) {
    const w = line.window, b = line.base;
    const text = `第 ${d.streak} 天：近两周正面回复 ${pct(w.pos, w.n)}，低于基准 ${b.month} ${pct(b.pos, b.n)}。跑 npm run retro`;
    try { await deps.notifyLocal('career-ops 复盘线触发', text); res.local = true; } catch (e) { res.errors.push(`系统通知失败：${e.message}`); }
    try { await deps.appendReminder(`- [ ] ${today} 🟥 复盘线触发（第 ${d.streak} 天）：窗口 ${pct(w.pos, w.n)} vs 基准 ${pct(b.pos, b.n)} → npm run retro`); }
    catch (e) { res.errors.push(`写 reminders 失败：${e.message}`); }
  }

  // Any delivery at all (Feishu or local) counts as today's alert, so a rerun
  // does not stack notifications.
  if (res.feishu === 'sent' || res.local) next.lastSent = today;
  deps.stateIO.write(next);
  return res;
}

export function describeCheck(r) {
  const head = {
    alert: `🟥 复盘线触发（第 ${r.streak} 天）：飞书消息 ${r.feishu}，加急 ${r.urgent}${r.local ? '，已弹系统通知' : ''}`,
    'already-sent': `🟥 复盘线触发（第 ${r.streak} 天）：今天已提醒过`,
    cooldown: '⏸ 复盘线冷却中（最近一次复盘未满 14 天）',
    resolved: '✅ 复盘已完成，本轮提醒解除',
    none: `🟩 复盘线正常（${r.line.status}）`,
  }[r.action] || r.action;
  return [head, ...r.errors.map(e => `   ⚠️ ${e}`)].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await runRetroCheck({ dryRun: process.argv.includes('--dry-run') });
  console.log(describeCheck(r));
  if (r.body) console.log(`\n（dry-run，未发送）\n${r.body}\n\n加急：lark-cli ${r.urgentArgs.join(' ')}`);
}
