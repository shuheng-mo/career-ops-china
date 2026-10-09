/**
 * capabilities.mjs — the ONLY place this project shells out to lark-cli.
 *
 * Everything Feishu-related goes through runLarkCli() here so that four things
 * are guaranteed in one place rather than re-derived per caller:
 *
 *   1. `--profile <name>` is ALWAYS passed. The CLI's default profile is global
 *      mutable state — another session running `lark-cli profile use` would
 *      silently redirect our writes into the wrong tenant. We therefore refuse
 *      to run at all rather than inherit it.
 *   2. `--format json` is ALWAYS passed. lark-cli >= 1.0.48 defaults to markdown
 *      output, which breaks every parser downstream.
 *   3. Writes get `--as user`. The bot identity is read-only; writes fail 91403.
 *   4. Requests are throttled (~5 req/s per the lark API guidance).
 *
 * It never adds `--yes`. Destructive lark-cli operations require that flag and
 * the CLI explicitly asks agents not to supply it on their own — so for those
 * we print the command and let a human run it.
 *
 * Capability gating: every feature module (calendar, task, notify, …) asks
 * isEnabled('<cap>') first and returns {ok:true, skipped:true, reason} when the
 * answer is no. "Not configured" is a normal outcome, never an exception —
 * this repo must run its whole pipeline on the md backend with no Feishu at all.
 */

import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const KNOWN_CAPABILITIES = ['bitable', 'calendar', 'task', 'im_card', 'dashboard', 'docs'];

function unquote(s) {
  if (!s) return '';
  return s.replace(/^["'](.*)["']$/, '$1').trim();
}

/**
 * Parse the `feishu:` block out of config/profile.yml.
 *
 * Hand-rolled rather than pulling in a YAML dependency: the only runtime dep
 * this project has is playwright, and "clone it and run the md backend with
 * zero install" is a property worth keeping. Mirrors the 2-level parser in
 * tracker-backend.mjs readProfileTracker().
 */
export function readProfileFeishu() {
  const result = { enabled: false, profile: '', capabilities: {}, config: {} };
  const profilePath = join(CAREER_OPS, 'config', 'profile.yml');
  if (!existsSync(profilePath)) return result;

  const lines = readFileSync(profilePath, 'utf-8').split('\n');
  let inFeishu = false;
  let subBlock = null;  // 'capabilities' | 'config' | null

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');

    if (/^[A-Za-z_]/.test(line) && !line.startsWith('feishu:')) {
      inFeishu = false;
      subBlock = null;
      continue;
    }
    if (line.startsWith('feishu:')) {
      inFeishu = true;
      subBlock = null;
      continue;
    }
    if (!inFeishu) continue;

    const noComment = line.replace(/\s+#.*$/, '');
    if (!noComment.trim()) continue;

    // 2-space keys directly under feishu:
    let m = noComment.match(/^  (enabled|profile):\s*(.*?)\s*$/);
    if (m) {
      const v = unquote(m[2]);
      if (m[1] === 'enabled') result.enabled = v === 'true';
      else result.profile = v;
      subBlock = null;
      continue;
    }
    if (/^  (capabilities|config):\s*$/.test(noComment)) {
      subBlock = noComment.trim().replace(':', '');
      continue;
    }
    // 4-space keys under a sub-block
    m = noComment.match(/^    ([a-z_]+):\s*(.*?)\s*$/);
    if (m && subBlock) {
      const v = unquote(m[2]);
      if (subBlock === 'capabilities') result.capabilities[m[1]] = v === 'true';
      else result.config[m[1]] = v;
      continue;
    }
    if (/^  [A-Za-z_]/.test(noComment)) subBlock = null;
  }

  return result;
}

let _cache = null;
export function feishuConfig() {
  if (!_cache) _cache = readProfileFeishu();
  return _cache;
}

/** Reset the memoized config. Only needed by tests that rewrite profile.yml. */
export function _resetConfigCache() { _cache = null; }

/**
 * Is a capability usable right now?
 *
 * `bitable` is special-cased: the tracker backend predates the feishu: block,
 * so it stays governed by tracker.backend and must keep working for users who
 * never add a feishu: section.
 */
export function isEnabled(cap) {
  const cfg = feishuConfig();
  if (!cfg.enabled) return false;
  if (!KNOWN_CAPABILITIES.includes(cap)) {
    throw new Error(`Unknown Feishu capability "${cap}". Known: ${KNOWN_CAPABILITIES.join(', ')}`);
  }
  return cfg.capabilities[cap] === true;
}

/** Uniform "did nothing, on purpose" result. Callers must treat it as success. */
export function skipped(cap, extra = '') {
  const cfg = feishuConfig();
  const reason = !cfg.enabled
    ? 'feishu.enabled is false in config/profile.yml'
    : `feishu.capabilities.${cap} is not true in config/profile.yml`;
  return { ok: true, skipped: true, cap, reason: extra ? `${reason} (${extra})` : reason };
}

/**
 * Resolve which lark-cli profile to use.
 *
 * Throws when unset. Falling back to the CLI default would mean writing into
 * whichever tenant some other session last selected — for calendar events and
 * chat messages that is an irreversible outward action.
 */
export function resolveProfile(explicit) {
  const p = explicit || feishuConfig().profile || readTrackerProfile();
  if (!p) {
    throw new Error(
      'No lark-cli profile configured. Set feishu.profile (or tracker.bitable.profile) ' +
      'in config/profile.yml. Refusing to fall back to the CLI default profile, which ' +
      'is global state and may point at a different tenant.'
    );
  }
  return p;
}

/** tracker.bitable.profile, for the backend that predates the feishu: block. */
function readTrackerProfile() {
  const profilePath = join(CAREER_OPS, 'config', 'profile.yml');
  if (!existsSync(profilePath)) return '';
  const m = readFileSync(profilePath, 'utf-8').match(/^\s{4}profile:\s*(.*?)\s*$/m);
  return m ? unquote(m[1].replace(/\s+#.*$/, '')) : '';
}

// ---- throttling (~5 req/s per lark API guidance) ----
const MIN_INTERVAL_MS = 220;
let _lastCallAt = 0;

function throttle() {
  const wait = MIN_INTERVAL_MS - (Date.now() - _lastCallAt);
  if (wait > 0) {
    // Deliberately synchronous: runLarkCli is sync (spawnSync) and callers are
    // sequential scripts, so a busy-free sleep keeps the API shape simple.
    const until = Date.now() + wait;
    while (Date.now() < until) { /* spin briefly */ }
  }
  _lastCallAt = Date.now();
}

/**
 * Run a lark-cli command.
 *
 * @param args    argv array WITHOUT `lark-cli`, e.g. ['base','+record-list',...]
 * @param opts.write      true → add `--as user` (bot identity is read-only)
 * @param opts.profile    override the configured profile
 * @param opts.format     output format, default 'json'; pass null to omit
 * @param opts.timeoutMs  default 30000
 */
export function runLarkCli(args, opts = {}) {
  const { write = false, profile, format = 'json', timeoutMs = 30000 } = opts;

  if (args.some(a => a === '--yes')) {
    throw new Error(
      'Refusing to run a lark-cli command carrying --yes. Destructive operations ' +
      'must be confirmed and run by the user, not by an agent.'
    );
  }

  const full = [...args];
  if (!full.includes('--profile')) full.push('--profile', resolveProfile(profile));
  if (format && !full.includes('--format')) full.push('--format', format);
  // Writes require user identity: the bot token has read-only scope and write
  // attempts come back as 91403.
  if (write && !full.includes('--as')) full.push('--as', 'user');

  throttle();
  const result = spawnSync('lark-cli', full, {
    encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0 || result.error) {
    throw classifyError(result, full);
  }
  return (result.stdout || '').trim();
}

/**
 * Turn a failed lark-cli invocation into an actionable Error.
 *
 * Order matters and is load-bearing: the word "auth" appears in the help text
 * of every command, so a naive match would report flag typos as auth problems.
 * Usage errors are checked first, then auth (an expired token must route to
 * re-login), then permissions (a missing scope).
 */
function classifyError(result, args) {
  const e = result.error || {};
  // Keep BOTH streams: lark-cli sometimes reports API/auth failures on stdout,
  // and dropping it would leave the classifiers with nothing to match.
  const out = (result.stderr || '') + (result.stdout || '') + (e.message ? `\n${e.message}` : '');
  const cmd = `lark-cli ${args.filter(a => !/^(--app-secret|--token)/.test(a)).join(' ')}`;

  if (/unknown flag|unknown command|invalid argument/i.test(out)) {
    return new Error(`lark-cli usage error (bug in career-ops, not your config):\n${cmd}\n${out}`);
  }
  if (/need_user_authorization|token_missing|token expired|invalid token|please login|unauthenticated|auth required|auth login/i.test(out)) {
    return new Error(
      `lark-cli auth failed. Refresh the token:\n` +
      `  lark-cli auth login --profile ${resolveProfileSafe()} --no-wait --json\n${out}`
    );
  }
  if (/permission_violations|permission denied|don't have permission|\b91403\b/i.test(out)) {
    return new Error(
      `lark-cli permission denied — missing scope. Check what the command needs:\n` +
      `  lark-cli schema <service.resource.method>\n` +
      `  lark-cli auth check --profile ${resolveProfileSafe()} --scope "<scope>"\n${out}`
    );
  }
  if (/ENOENT/i.test(e.code || '') || /not found/i.test(e.message || '')) {
    return new Error(
      'lark-cli is not installed or not on PATH. Feishu capabilities need it; ' +
      'set feishu.enabled: false in config/profile.yml to run without them.'
    );
  }
  return new Error(`lark-cli error:\n${cmd}\n${out.trim() || e.message}`);
}

function resolveProfileSafe() {
  try { return resolveProfile(); } catch { return '<profile>'; }
}

/**
 * Parse lark-cli stdout as JSON.
 *
 * Some commands print multi-line diagnostic headers before the payload, so fall
 * back to scanning for the trailing top-level object/array.
 */
export function parseJsonOut(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    const m = stdout.match(/[\[{][\s\S]*[\]}]\s*$/);
    if (m) return JSON.parse(m[0]);
    throw new Error(`Failed to parse lark-cli output as JSON. Got:\n${stdout.slice(0, 500)}`);
  }
}

/** Health check used by `npm run feishu:check` and modes/feishu.md. */
export function healthCheck() {
  const cfg = feishuConfig();
  const report = { enabled: cfg.enabled, profile: cfg.profile || '(from tracker.bitable.profile)', capabilities: {} };
  for (const cap of KNOWN_CAPABILITIES) {
    report.capabilities[cap] = cfg.enabled ? (cfg.capabilities[cap] === true) : false;
  }
  return report;
}
