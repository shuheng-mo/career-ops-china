#!/usr/bin/env node
/**
 * notify.mjs — one-way daily digest to the candidate's own Feishu DM.
 *
 * Before this, the system had exactly one notification channel: the mobile push
 * from the cloud radar routine. Everything else — a stale application, a blocked
 * track, a high-scoring evaluation nobody ever applied to — was visible only if
 * someone opened the tracker. Which, for three months, nobody did.
 *
 * Sent BY THE BOT, not by the user to themselves. That distinction is the whole
 * feature: `--as user --user-id <self>` delivers into the user's own self-chat,
 * which Feishu does not raise a notification for, so the digest arrives and is
 * never seen — reproducing exactly the "state nobody looks at" problem it exists
 * to fix. `--as bot` opens a real p2p conversation that does notify. The first
 * version shipped the wrong one and the digest sat silently in 我的空间.
 *
 * Deliberately ONE-WAY. No buttons, no callbacks, no resident process:
 *  - `event consume` would need a long-lived listener; the user ruled that out.
 *  - and `base` is not among the event domains anyway, so a Bitable edit could
 *    never have been the trigger.
 * The digest therefore links into Bitable and the user changes Status there,
 * which is where they already change it.
 *
 * Why Markdown and not an interactive card: lark-cli mandates a card-construction
 * workflow for any `--msg-type interactive` payload and forbids hand-written card
 * JSON. A digest with headings, bullets and links gains nothing from a card, and
 * `--markdown` is the CLI's own recommended form for "summaries or reports".
 *
 * Run: node tools/feishu/notify.mjs [--dry-run]
 * Plugin contract is the same as schedule.mjs: capability off → { skipped: true }.
 */

import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runLarkCli, parseJsonOut, isEnabled, skipped, feishuConfig } from './capabilities.mjs';
import { listApplications, readProfileTracker, trackDirection, TRACK_FIT } from '../tracker-backend.mjs';
import { buildPulse } from './pulse.mjs';

const CAREER_OPS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Application-gate thresholds, mirroring the fit × Tier table in modes/_shared.md.
// Tier is a judgement the evaluation makes and is not stored in the tracker, so
// the digest uses the LOWER (Tier A/B) bound — it is a nudge list, not a decision.
const GATE_BY_FIT = { primary: 3.8, secondary: 4.1, bridge: 4.1, 'evidence-gated': 4.1 };

const STALE_DAYS = 7;

function daysSince(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return null;
  const ms = Date.now() - new Date(dateStr.slice(0, 10) + 'T00:00:00').getTime();
  return Math.floor(ms / 86400000);
}

function scoreOf(rec) {
  const m = String(rec.score || '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function gateFor(track) {
  return GATE_BY_FIT[TRACK_FIT[track || 'ai-app'] || 'primary'] ?? 3.8;
}

/** Newest data/radar-leads-*.md and how many leads it lists. */
function latestRadar() {
  const dir = join(CAREER_OPS, 'data');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => /^radar-leads-.*\.md$/.test(f)).sort();
  if (files.length === 0) return null;
  const newest = files[files.length - 1];
  const m = newest.match(/(\d{4}-\d{2}-\d{2})/);
  return { file: newest, date: m ? m[1] : '', ageDays: m ? daysSince(m[1]) : null };
}

export async function buildDigest() {
  const apps = await listApplications();
  const cfg = readProfileTracker();

  const stale = [];
  const ready = [];
  const blocked = [];

  for (const a of apps) {
    const age = daysSince(a.date);

    if ((a.status === 'Applied' || a.status === 'Responded') && age !== null && age > STALE_DAYS) {
      stale.push({ ...a, age });
    }
    if (a.status === 'Evaluated' && scoreOf(a) >= gateFor(a.track)) {
      ready.push({ ...a, age, gate: gateFor(a.track) });
    }
    if (a.status === 'Blocked') blocked.push(a);
  }

  // Oldest first: the thing rotting longest needs the nudge most.
  stale.sort((x, y) => y.age - x.age);
  // Best first: this is a work queue.
  ready.sort((x, y) => scoreOf(y) - scoreOf(x));

  const byDirection = {};
  for (const r of ready) {
    const d = trackDirection(r.track);
    byDirection[d] = (byDirection[d] || 0) + 1;
  }

  // The stop-sending signal leads the digest: it is the one line that should
  // change what the candidate does today. A failure here must not sink the digest.
  let pulse = null;
  try { const P = await buildPulse(); pulse = { signal: P.signal, reason: P.reason, missing: P.missingAppliedAt.length }; } catch { /* best-effort */ }

  return {
    total: apps.length,
    pulse,
    stale,
    ready,
    blocked,
    byDirection,
    radar: latestRadar(),
    baseUrl: cfg.bitable?.base_url || '',
  };
}

const CAP = 8;   // keep the message glanceable; the link covers the long tail

export function renderDigest(d) {
  const today = new Date().toISOString().slice(0, 10);
  const L = [`## career-ops 日报 · ${today}`, ''];

  const dirLine = Object.entries(d.byDirection).map(([k, v]) => `${k} ${v}`).join(' · ');
  if (d.pulse) {
    L.push(`### 投递脉搏：${d.pulse.signal}`);
    L.push(`- ${d.pulse.reason}`);
    if (d.pulse.missing) L.push(`- ${d.pulse.missing} 个在途岗位缺投递日期，没进模型`);
    L.push('');
  }
  L.push(`**在库 ${d.total} 条**　待投 ${d.ready.length}${dirLine ? `（${dirLine}）` : ''}　超期未跟进 ${d.stale.length}　证据闸门 ${d.blocked.length}`);
  L.push('');

  if (d.stale.length) {
    L.push(`### ⏰ 超期未跟进（>${STALE_DAYS} 天）`);
    for (const s of d.stale.slice(0, CAP)) {
      L.push(`- #${s.num} ${s.company} — ${s.role}｜${s.status} ${s.age} 天`);
    }
    if (d.stale.length > CAP) L.push(`- …还有 ${d.stale.length - CAP} 条`);
    L.push('');
  }

  if (d.ready.length) {
    L.push('### 🔥 过闸门待投（按分降序）');
    for (const r of d.ready.slice(0, CAP)) {
      L.push(`- #${r.num} ${r.company} — ${r.role}｜${r.score}（闸门 ${r.gate}）${r.track ? `｜${r.track}` : ''}`);
    }
    if (d.ready.length > CAP) L.push(`- …还有 ${d.ready.length - CAP} 条`);
    L.push('');
  }

  if (d.blocked.length) {
    L.push('### 🧱 证据闸门待解锁');
    for (const b of d.blocked.slice(0, CAP)) {
      L.push(`- #${b.num} ${b.company} — ${b.role}｜${b.notes || '（notes 未写缺口）'}`);
    }
    L.push('');
  }

  if (d.radar) {
    const age = d.radar.ageDays;
    L.push(`### 📡 雷达`);
    L.push(age !== null && age > 3
      ? `- 最近一批线索是 ${d.radar.date}（${age} 天前）—— routine 可能没跑`
      : `- 最近一批线索：${d.radar.date}`);
    L.push('');
  }

  if (!d.stale.length && !d.ready.length && !d.blocked.length) {
    L.push('今天没有待办 —— 队列是干净的。');
    L.push('');
  }

  if (d.baseUrl) L.push(`[去 Bitable 改状态](${d.baseUrl})`);
  return L.join('\n');
}

export async function sendDigest({ dryRun = false } = {}) {
  const digest = await buildDigest();
  const body = renderDigest(digest);

  if (dryRun) {
    // Print the message, then also ask lark-cli to show the request it would
    // send — that second half is what catches an argv mistake. Both halves are
    // side-effect free.
    console.log(body);
    console.log('\n--- lark-cli request (dry-run) ---');
    const probe = send(body, true);
    console.log(probe.ok ? (probe.raw || '').slice(0, 800) : `(skipped: ${probe.reason || probe.error})`);
    return { ok: true, skipped: false, dryRun: true, body };
  }

  if (!isEnabled('im_card')) {
    // No local fallback here on purpose: unlike a reminder, a digest is derived
    // state. Nothing is lost by not sending it — re-run and it rebuilds.
    console.log(body);
    return { ...skipped('im_card', 'digest printed to stdout instead'), body };
  }

  return send(body, false);
}

function send(body, dryRun) {
  if (!isEnabled('im_card')) return skipped('im_card');

  const openId = feishuConfig().config?.self_open_id || '';
  if (!openId) {
    return { ok: false, error: 'feishu.config.self_open_id is not set in config/profile.yml. '
      + 'Find it with: lark-cli whoami --profile <p>' };
  }

  const args = [
    'im', '+messages-send',
    '--user-id', openId,
    '--markdown', body,
    // One digest per day per recipient, so a double-run can't double-ping.
    // The `bot` segment matters: the key is honoured independently of the chat,
    // so a key already spent on the (wrong) user-identity channel would dedupe
    // the bot send into a silent no-op.
    '--idempotency-key', `career-ops:digest:bot:${new Date().toISOString().slice(0, 10)}`,
  ];
  if (dryRun) args.push('--dry-run');

  try {
    // as: 'bot' — see the header note. User identity would deliver silently.
    const out = runLarkCli(args, { write: true, as: 'bot', timeoutMs: 30000 });
    const data = parseJsonOut(out)?.data ?? null;

    // Verify delivery instead of trusting the exit code. The first version
    // reported "sent" on exit 0 alone, which told us nothing about whether a
    // message actually existed — and it did not help when the digest turned out
    // to be going somewhere unnotified.
    if (!dryRun && !data?.message_id) {
      return { ok: false, error: `lark-cli exited 0 but returned no message_id. Raw:\n${out.slice(0, 400)}` };
    }
    return {
      ok: true, skipped: false, dryRun, raw: out, data,
      messageId: data?.message_id, chatId: data?.chat_id,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// CLI entry
if (process.argv[1] && process.argv[1].endsWith('notify.mjs')) {
  const res = await sendDigest({ dryRun: process.argv.includes('--dry-run') });
  if (res.skipped) console.log(`\n⏭  ${res.reason}`);
  else if (!res.ok) { console.error(`❌ ${res.error}`); process.exit(1); }
  else if (!res.dryRun) console.log(`✅ digest sent — message ${res.messageId} in chat ${res.chatId}`);
}
