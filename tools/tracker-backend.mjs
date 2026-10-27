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
 *   { num, date, company, role, score, status, pdf, report, notes, track,
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

/**
 * Bulk update. Prefer this over looping updateApplication(): on the Bitable
 * backend each single update re-lists the entire table to resolve num ->
 * record_id, so a loop over N rows costs N full listings.
 */
export async function updateMany(records) {
  return (await getBackend()).updateMany(records);
}

export async function findByCompanyRole(company, role, url) {
  return (await getBackend()).findByCompanyRole(company, role, url);
}

export async function getMaxNum() {
  return (await getBackend()).getMaxNum();
}

export async function aggregateByStatus() {
  return (await getBackend()).aggregateByStatus();
}

// Shared helpers — used by both backends + callers.
// This is the single definition; merge-tracker and setup-bitable-tracker import
// it rather than keeping their own copies (they used to, and drifted).
export const CANONICAL_STATES = [
  'Evaluated', 'Applied', 'Responded', 'Interview',
  'Offer', 'Rejected', 'Discarded', 'SKIP', 'Blocked',
];

// Terminal states = lifecycle ended; Closed At should be populated.
// Offer is terminal because once received, the candidate decides accept/decline
// (further state changes are via Applied→Offer→Accepted/Rejected, handled by notes).
//
// Blocked is deliberately NOT terminal: it means "evaluated, but held back by a
// documented evidence gap" (see the evidence gate in modes/_profile.md). It is an
// active state that unblocks once the candidate closes the gap, so it must not
// get a Closed At and must not be counted as dead in the funnel.
export const TERMINAL_STATES = new Set(['Rejected', 'Discarded', 'SKIP', 'Offer']);

// ---- Tracks (skill axis × industry axis) ----
// The authoritative narrative definition lives in modes/_profile.md's Track table
// (gitignored — it carries the candidate's profile). This is the machine-readable
// half: the enum the tracker column, the Bitable select and the gate lookup share.
//
// Deliberately an enumeration of the 6 cells we care about, NOT a free Cartesian
// product of archetype × domain — that would invent cells like "perception × banking".
export const TRACKS = [
  'ai-app',          // AI application / Agent, any industry      — primary
  'ai-app-auto',     // AI application / Agent, automotive        — secondary
  'auto-data',       // ADAS data loop / data platform (auto only)— secondary
  'auto-algo',       // ADAS perception / planning algorithms     — evidence-gated
  'ai-data-bridge',  // AI data platform / data engineering       — bridge
  'ai-gov-bridge',   // data governance + LLM                     — bridge
];

// Gate lookup key. modes/_shared.md holds the fit × Tier threshold table; this
// map is what turns a track into that table's row.
export const TRACK_FIT = {
  'ai-app': 'primary',
  'ai-app-auto': 'secondary',
  'auto-data': 'secondary',
  'auto-algo': 'evidence-gated',
  'ai-data-bridge': 'bridge',
  'ai-gov-bridge': 'bridge',
};

// Coarse direction, for funnel grouping. Mirrors the `Direction` formula field in
// Bitable so md and Bitable group identically.
export function trackDirection(track) {
  if (!track) return 'AI';            // empty == ai-app; see normalizeTrack
  return String(track).includes('auto') ? 'AUTO' : 'AI';
}

/**
 * Accept a track value from a TSV / md cell / Bitable select and return either a
 * valid track id or '' (meaning "unset", which is equivalent to ai-app).
 *
 * Empty is legal and is NOT a fallback: every row written before 2026-10-10 was
 * single-direction ai-app, so a blank cell is a true statement about those rows,
 * not a missing value. Throwing on unknown values instead of silently coercing
 * keeps a typo'd track from landing in the tracker and skewing the per-track funnel.
 */
export function normalizeTrack(value) {
  const v = String(value ?? '').trim();
  if (!v || v === '—' || v === '-') return '';
  const hit = TRACKS.find(t => t.toLowerCase() === v.toLowerCase());
  if (!hit) {
    throw new Error(`Unknown track "${v}". Expected one of ${TRACKS.join(', ')} (or empty for ai-app).`);
  }
  return hit;
}

// ---- Funnel detail (2026-10-15) ----
// Status stores only the CURRENT state, so a row that went Interview → Rejected
// forgets that it ever reached an interview, and nothing records when it was
// sent or how fast anyone answered. These enums back the stored fields that keep
// that history; tools/feishu/pulse.mjs turns them into the response-speed model.
// Each is a Bitable single-select, so the option lists here ARE the schema.

// Where the application went out. Channel drives the expected response curve —
// a careers portal answering in 2 weeks is normal, Boss going quiet for 2 weeks
// is not — so the pulse model baselines each channel separately.
export const CHANNELS = ['官网', 'Boss', '猎聘', '猎头', '内推', 'LinkedIn', '其他'];

// The first thing that came back. Rejection counts as a response: it proves the
// CV was read, which is what the speed model measures.
export const RESPONSE_TYPES = ['拒信', 'HR沟通', '约面'];

// Ordered: index = how far the process got. '未面' means a response that never
// became an interview (e.g. HR chat, then silence).
export const INTERVIEW_STAGES = ['未面', '笔试', '一面', '二面', '三面', 'HR面', '终面', 'Offer'];

// Where it ended. Separate from INTERVIEW_STAGES because "reached 二面" and
// "failed at 二面" differ from "withdrew after 二面" — and that difference is
// exactly what tells a CV problem from an interview problem.
export const EXIT_STAGES = [
  '简历关', '笔试挂', '一面挂', '二面挂', '三面挂', 'HR面挂', '终面挂',
  'Offer被撤', '候选人放弃', '无回复', '岗位关闭', '录用',
];

// One row per interview round, in the Interviews table.
export const ROUND_RESULTS = ['通过', '挂', '待定', '取消'];
export const ROUND_FORMATS = ['电话', '视频', '现场', '笔试'];

export function isTerminal(status) {
  return TERMINAL_STATES.has(status);
}

// Keep CJK letters + numbers; drop only whitespace/punctuation/symbols.
// The old `[^a-z0-9]` stripped ALL Chinese, collapsing every CN company
// name to "" (so all CN companies compared equal — see dedup bug).
export function normalizeCompany(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[\s　]+/g, '')          // whitespace incl. full-width space
    .replace(/[^\p{L}\p{N}]/gu, '');  // keep all Unicode letters (incl. CJK) + numbers
}

/**
 * Do two posting URLs point at the same job? true / false, or null when either
 * side has no usable URL (then the caller falls back to company + role).
 *
 * Exists because company + roleFuzzyMatch is far too loose inside one big
 * employer: one bulk pull from a large company's careers site had 12 distinct
 * postings swallowed as "duplicates" of each other ("X Harness 工程师" vs
 * "Y-X Harness 算法工程师", two different "支付-全栈开发工程师" roles...),
 * plus a fresh role matched against a different, months-old role at the same
 * company. Distinct posting URLs are a much stronger signal than title similarity.
 *
 * Compares host + path, plus the id-carrying query params some sites use
 * (careers.tencent.com/jobdesc.html?postId=..., zhaopin.meituan.com/web/position/detail?jobUnionId=...);
 * tracking params are ignored.
 */
export function sameJobUrl(a, b) {
  const key = (u) => {
    // Bitable stores the URL column as a markdown link: `[https://…](https://…)`
    u = String(u || '').trim().replace(/^\[[^\]]*\]\((.*)\)$/, '$1');
    if (!u || !/^https?:\/\//.test(u)) return null;
    try {
      const x = new URL(u);
      const id = ['postId', 'jobId', 'positionId', 'jobUnionId', 'id'].map(k => x.searchParams.get(k)).find(Boolean) || '';
      return `${x.hostname.replace(/^(www|cn|m)\./, '')}${x.pathname.replace(/\/+$/, '')}${id ? `?${id}` : ''}`.toLowerCase();
    } catch { return null; }
  };
  const ka = key(a), kb = key(b);
  if (!ka || !kb) return null;
  return ka === kb;
}

// Matches both English (multi-word) and CJK (no-space) role titles.
// NOTE: in dedup this only fires AFTER normalizeCompany matched, i.e. within
// the SAME company — so a loose match here can at worst create a duplicate
// (recoverable), never merge two different companies (data loss).
export function roleFuzzyMatch(a, b) {
  const norm = s => (s || '')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Substring containment: "数据工程师" vs "高级数据工程师", "X工程师" vs "X工程师(K12方向)"
  if (na.includes(nb) || nb.includes(na)) return true;
  // English titles: ≥2 shared words of length >3
  const wordsA = (a || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const wordsB = (b || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const overlap = wordsA.filter(w => wordsB.some(wb => wb.includes(w) || w.includes(wb)));
  if (overlap.length >= 2) return true;
  // CJK titles that aren't exact/substring: character-set Jaccard ≥ 0.7
  if (/[一-鿿]/.test(na + nb)) {
    const setA = new Set(na), setB = new Set(nb);
    let inter = 0;
    for (const c of setA) if (setB.has(c)) inter++;
    const union = new Set([...na, ...nb]).size;
    if (union > 0 && inter / union >= 0.7) return true;
  }
  return false;
}
