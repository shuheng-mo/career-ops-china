/**
 * retro-core.mjs — the 复盘线 (retro trigger line) and its alert state machine.
 *
 * One question, asked every day: did the most recent two weeks of applications
 * that have had at least 14 days to answer get POSITIVE replies (HR contact or
 * an interview) at a lower rate than the baseline month? If so, stop sending
 * and run a retro (`npm run retro`).
 *
 * This is deliberately not pulse.mjs's Poisson signal. That one counts any
 * reply against the whole pre-restart history; this one excludes rejections
 * (careers portals auto-reject, so a "reply" there is noise) and compares with
 * the month the candidate's strategy demonstrably worked.
 *
 * Pure computation plus small file helpers. Shared by pulse, the daily digest,
 * the 9:00 alert (tools/feishu/retro-alert.mjs) and the report (tools/retro.mjs),
 * so all four always agree on the number.
 *
 * Spec: docs/superpowers/specs/2026-11-16-retro-trigger-design.md
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const CAREER_OPS = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RETRO_DIR = join(CAREER_OPS, 'data', 'retro');
const STATE_FILE = join(RETRO_DIR, '.alert-state.json');

/** A retro file containing this marker is a draft, not a completed retro. */
export const PLACEHOLDER = '待 Claude 与用户填写';
export const COOLDOWN_DAYS = 14;
export const MIN_N = 10;
const MATURE_DAYS = 14;      // an application younger than this has not had its chance to answer
const WINDOW_DAYS = 14;      // "the last two weeks"
const MAX_AGE = 55;          // widen the window a week at a time, at most to 6 weeks

// ---- dates (Beijing calendar days, same as pulse.mjs) ----
export const todayBJ = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
/** Normalise any date-ish value ("2026-11-13 00:00:00", "2026-11-13") to YYYY-MM-DD, or ''. */
export const day = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(String(s)) ? String(s).slice(0, 10) : '');
const dayNum = (s) => Math.round(new Date(`${s}T00:00:00Z`).getTime() / 86400000);
export const daysBetween = (a, b) => dayNum(b) - dayNum(a);
export const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---- what counts as a positive reply ----
const POSITIVE = new Set(['HR沟通', '约面']);
const reachedInterview = (app) => !!app.furthestStage && app.furthestStage !== '未面';

export function isPositive(app) {
  return POSITIVE.has(app.firstResponse) || reachedInterview(app);
}

/** '拒信' | 'HR沟通' | '约面' | '无'. A recorded interview stage without a recorded first response reads as 约面. */
export function responseKind(app) {
  if (app.firstResponse) return app.firstResponse;
  return reachedInterview(app) ? '约面' : '无';
}

// The clock the retro line runs on: when this row's recruitment contact started.
// Legacy rows have no contactedAt — under the pre-2026-11-18 workflow appliedAt
// WAS the first outbound contact event (Boss greeting / outreach message), so it
// is the documented proxy anchor. With contactedAt empty everywhere today this
// is an identity change; new rows record the real Contacted At.
const anchor = (app) => day(app.contactedAt || app.appliedAt);

const ageOf = (app, today) => { const a = anchor(app); return a ? daysBetween(a, today) : null; };

/** Applications that went out and have had at least 14 days. */
export function matured(apps, today) {
  return apps.filter(a => { const age = ageOf(a, today); return age !== null && age >= MATURE_DAYS; });
}

const summarise = (rows) => ({ rows, n: rows.length, pos: rows.filter(isPositive).length });

/** The last two weeks of matured applications, widened a week at a time until n >= MIN_N. */
export function retroWindow(apps, today) {
  let oldest = MATURE_DAYS + WINDOW_DAYS - 1;            // ages 14..27
  for (;;) {
    const rows = apps.filter(a => { const age = ageOf(a, today); return age !== null && age >= MATURE_DAYS && age <= oldest; });
    if (rows.length >= MIN_N || oldest >= MAX_AGE) {
      return { from: addDays(today, -oldest), to: addDays(today, -MATURE_DAYS), ...summarise(rows), enough: rows.length >= MIN_N };
    }
    oldest = Math.min(MAX_AGE, oldest + 7);
  }
}

/** Positive-reply rate of the baseline month (matured rows only). */
export function baseline(apps, month, today) {
  const rows = matured(apps, today).filter(a => anchor(a).startsWith(month));
  const s = summarise(rows);
  return { month, ...s, rate: s.n ? s.pos / s.n : null };
}

/** `retro: baseline_month:` from config/profile.yml. Hand-rolled like readProfileFeishu (zero-dep). */
export function readRetroConfig(profilePath = join(CAREER_OPS, 'config', 'profile.yml')) {
  if (!existsSync(profilePath)) return { baselineMonth: null };
  let inRetro = false;
  for (const raw of readFileSync(profilePath, 'utf-8').split('\n')) {
    const line = raw.replace(/\r$/, '').replace(/\s+#.*$/, '');
    if (/^[A-Za-z_]/.test(line)) { inRetro = line.startsWith('retro:'); continue; }
    const m = inRetro && line.match(/^  baseline_month:\s*["']?(\d{4}-\d{2})["']?\s*$/);
    if (m) return { baselineMonth: m[1] };
  }
  return { baselineMonth: null };
}

/** status: 'below' | 'ok' | 'insufficient' | 'no-baseline'. Below means strictly under the baseline rate. */
export function retroLine(apps, { today = todayBJ(), baselineMonth } = {}) {
  const window = retroWindow(apps, today);
  const rate = window.n ? window.pos / window.n : null;
  if (!baselineMonth) return { status: 'no-baseline', window, base: null, rate, baseRate: null };
  const base = baseline(apps, baselineMonth, today);
  if (!base.n) return { status: 'no-baseline', window, base, rate, baseRate: null };
  if (!window.enough) return { status: 'insufficient', window, base, rate, baseRate: base.rate };
  return { status: rate < base.rate ? 'below' : 'ok', window, base, rate, baseRate: base.rate };
}

// ---- retro files ----
export function listRetros(dir = RETRO_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map(f => ({ f, m: f.match(/^(\d{4}-\d{2}-\d{2}).*-retro\.md$/) }))
    .filter(x => x.m)
    .map(({ f, m }) => ({ file: join(dir, f), date: m[1], completed: !readFileSync(join(dir, f), 'utf-8').includes(PLACEHOLDER) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.file.localeCompare(b.file));
}

export function lastCompleted(retros) {
  const done = retros.filter(r => r.completed).map(r => r.date).sort();
  return done.length ? done[done.length - 1] : null;
}

/** Last day of the cooldown that follows the most recent completed retro, or null. */
export function cooldownUntil(retros) {
  const last = lastCompleted(retros);
  return last ? addDays(last, COOLDOWN_DAYS) : null;
}

// ---- alert state ----
export function readAlertState(file = STATE_FILE) {
  try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return {}; }
}
export function writeAlertState(state, file = STATE_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

/**
 * State-based, not edge-triggered: alert every day while the line is below and
 * no completed retro has been written since the round began. A missed day (Mac
 * asleep) is simply caught the next day.
 *
 * Returns the state to persist. For 'alert', the sender sets lastSent/messageId
 * after it actually sends.
 */
export function decideAlert({ line, retros, state = {}, today }) {
  const last = lastCompleted(retros);
  if (state.active && last && last >= state.firstTriggered) return { action: 'resolved', state: { active: false }, streak: 0 };
  if (last && daysBetween(last, today) < COOLDOWN_DAYS) return { action: 'cooldown', state: { active: false }, streak: 0 };
  if (line.status !== 'below') return { action: 'none', state: { active: false }, streak: 0 };

  const firstTriggered = state.active ? state.firstTriggered : today;
  const next = { ...(state.active ? state : {}), active: true, firstTriggered };
  const streak = daysBetween(firstTriggered, today) + 1;
  return { action: state.active && state.lastSent === today ? 'already-sent' : 'alert', state: next, streak };
}

/**
 * One-line status for pulse and the digest. An open alert round outranks
 * everything; then cooldown; then what the line itself says.
 */
export function retroStatus(apps, { today = todayBJ(), baselineMonth, retros = listRetros(), alert = readAlertState() } = {}) {
  const line = retroLine(apps, { today, baselineMonth });
  const until = cooldownUntil(retros);
  // A retro finished at 10:00 closes the round now, not at tomorrow's 9:00 run.
  const last = lastCompleted(retros);
  const active = !!alert.active && !(last && last >= alert.firstTriggered);
  let label;
  if (active) label = `🟥 触发（第 ${daysBetween(alert.firstTriggered, today) + 1} 天）`;
  else if (until && daysBetween(today, until) > 0) label = `⏸ 冷却中至 ${until}`;
  else label = {
    below: '🟥 线下（今天 9:00 检查会触发）',
    ok: '🟩 正常',
    insufficient: '⚪ 数据不足（窗口不到 10 条）',
    'no-baseline': '⚪ 未配置基准月',
  }[line.status];
  return { line, cooldownUntil: until, active, label };
}
