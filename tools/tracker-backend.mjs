/**
 * tracker-backend.mjs — Unified tracker API abstraction.
 *
 * Reads config/profile.yml `tracker.backend` (md | bitable) and dispatches to
 * the corresponding concrete backend in tools/backends/.
 *
 * Public API (same for all backends):
 *   listApplications()        → Promise<Record[]>
 *   addApplication(rec)       → Promise<{num: number, inserted: boolean}>
 *   updateApplication(num, fields) → Promise<void>
 *   findByCompanyRole(c, r)   → Promise<Record | null>
 *   getMaxNum()               → Promise<number>
 *   aggregateByStatus()       → Promise<{[status]: number}>
 *
 * Normalized Record shape:
 *   { num, date, company, role, score, status, pdf, report, notes,
 *     url (optional, bitable-only), linked (optional) }
 *
 * Callers must not assume backend-specific details. If a field doesn't exist
 * in the md backend, it returns "" (empty string) rather than undefined.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const CAREER_OPS = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read a dotted key path from profile.yml. Handles only the tracker.* section
 * (simple 2-level nesting); not a general YAML parser.
 *
 * Returns string value or empty string if not found / not set.
 */
export function readProfileTracker() {
  const profilePath = join(CAREER_OPS, 'config', 'profile.yml');
  if (!existsSync(profilePath)) {
    return { backend: 'md', bitable: {} };
  }

  const content = readFileSync(profilePath, 'utf-8');

  // Locate the `tracker:` top-level block and parse the following indented lines.
  const lines = content.split('\n');
  const result = { backend: 'md', bitable: {} };

  let inTracker = false;
  let inBitable = false;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');

    if (/^[A-Za-z_]/.test(line) && !line.startsWith('tracker:')) {
      // Hit another top-level section → end of tracker block
      inTracker = false;
      inBitable = false;
      continue;
    }

    if (line.startsWith('tracker:')) {
      inTracker = true;
      inBitable = false;
      continue;
    }

    if (!inTracker) continue;

    // Strip inline comments for parsing
    const noComment = line.replace(/\s+#.*$/, '');

    // 2-space indent under tracker:
    let m = noComment.match(/^  backend:\s*(.*?)\s*$/);
    if (m) {
      result.backend = unquote(m[1]) || 'md';
      inBitable = false;
      continue;
    }

    if (/^  bitable:\s*$/.test(noComment)) {
      inBitable = true;
      continue;
    }

    if (inBitable) {
      // 4-space indent under bitable:
      m = noComment.match(/^    ([a-z_]+):\s*(.*?)\s*$/);
      if (m) {
        result.bitable[m[1]] = unquote(m[2]);
      } else if (/^  [A-Za-z_]/.test(noComment)) {
        // Other 2-space key (not bitable) → exit bitable block
        inBitable = false;
      }
    }
  }

  return result;
}

function unquote(s) {
  if (!s) return '';
  return s.replace(/^["'](.*)["']$/, '$1').trim();
}

/**
 * Load the configured backend. Cached per-process.
 */
let _backendCache = null;
export async function getBackend() {
  if (_backendCache) return _backendCache;

  const cfg = readProfileTracker();
  const name = cfg.backend || 'md';

  let mod;
  if (name === 'bitable') {
    mod = await import('./backends/bitable-backend.mjs');
  } else if (name === 'md') {
    mod = await import('./backends/md-backend.mjs');
  } else {
    throw new Error(`Unknown tracker.backend: "${name}". Expected "md" or "bitable".`);
  }

  _backendCache = mod.create(cfg);
  _backendCache.backendName = name;
  _backendCache.config = cfg;
  return _backendCache;
}

// Convenience re-exports — dispatch to backend
export async function listApplications() {
  return (await getBackend()).listApplications();
}

export async function addApplication(rec) {
  return (await getBackend()).addApplication(rec);
}

export async function updateApplication(num, fields) {
  return (await getBackend()).updateApplication(num, fields);
}

export async function findByCompanyRole(company, role) {
  return (await getBackend()).findByCompanyRole(company, role);
}

export async function getMaxNum() {
  return (await getBackend()).getMaxNum();
}

export async function aggregateByStatus() {
  return (await getBackend()).aggregateByStatus();
}

// Shared helpers — used by both backends + callers
export const CANONICAL_STATES = [
  'Evaluated', 'Applied', 'Responded', 'Interview',
  'Offer', 'Rejected', 'Discarded', 'SKIP',
];

// Terminal states = lifecycle ended; Closed At should be populated.
// Offer is terminal because once received, the candidate decides accept/decline
// (further state changes are via Applied→Offer→Accepted/Rejected, handled by notes).
export const TERMINAL_STATES = new Set(['Rejected', 'Discarded', 'SKIP', 'Offer']);

export function isTerminal(status) {
  return TERMINAL_STATES.has(status);
}

export function normalizeCompany(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function roleFuzzyMatch(a, b) {
  const wordsA = (a || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const wordsB = (b || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const overlap = wordsA.filter(w => wordsB.some(wb => wb.includes(w) || w.includes(wb)));
  return overlap.length >= 2;
}
