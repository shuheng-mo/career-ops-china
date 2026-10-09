/**
 * bitable-backend.mjs — Feishu (Lark) Bitable backend via lark-cli.
 *
 * Shell-outs to `lark-cli base +<cmd>` and parses JSON output.
 * Reads app_token + table_id_applications from profile.yml's tracker.bitable section.
 *
 * Field mapping (Bitable → normalized record):
 *   Num (number)       ↔ num
 *   Date (date ms)     ↔ date (YYYY-MM-DD)
 *   Company (text)     ↔ company
 *   Role (text)        ↔ role
 *   Score (text)       ↔ score      (kept as string "4.2/5" / "N/A")
 *   Status (select)    ↔ status     (canonical enum)
 *   PDF (checkbox)     ↔ pdf        ("✅" | "❌")
 *   URL (url)          ↔ url
 *   Report (text)      ↔ report     (markdown link string)
 *   Notes (long text)  ↔ notes
 *
 * Hard limits (from lark-base skill):
 *  - Batch 500 records/upsert; sleep 1s between batches
 *  - Don't write formula/lookup fields (they're auto-computed)
 *  - Date writes use a "YYYY-MM-DD HH:mm:ss" string, NOT a ms timestamp
 *    (reads tolerate both; see dateToUpsertString / toDateStr below)
 *  - Status value must be in pre-created single-select options
 */

import { normalizeCompany, roleFuzzyMatch, CANONICAL_STATES, isTerminal } from '../tracker-backend.mjs';
// All lark-cli invocation goes through this one module: it guarantees --profile
// (the CLI default is global state and may point at another tenant), --format
// json, --as user on writes, and throttling. See tools/feishu/capabilities.mjs.
import { runLarkCli as larkCli, parseJsonOut } from '../feishu/capabilities.mjs';

// ---- low-level lark-cli bridge ----
// Thin shim over tools/feishu/capabilities.mjs. `write: true` makes it add
// `--as user`, which writes require (the bot identity is read-only → 91403).
function runLarkCli(args, { timeoutMs = 30000, write = false } = {}) {
  return larkCli(args, { timeoutMs, write });
}

// ---- Field mapping helpers ----

function msToDate(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Format for +record-upsert: "YYYY-MM-DD HH:mm:ss" string (NOT ms timestamp).
 * Input accepts "YYYY-MM-DD" (adds midnight) or existing full datetime string.
 */
function dateToUpsertString(dateStr) {
  if (!dateStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return `${dateStr} 00:00:00`;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(dateStr)) {
    return dateStr.replace('T', ' ').slice(0, 19);
  }
  return null;
}

function recordToNormalized(record) {
  const f = record.fields || record;
  const status = Array.isArray(f.Status) ? (f.Status[0] || '') : (f.Status || '');
  const toDateStr = (v) => {
    if (typeof v === 'string' && v.length >= 10) return v.slice(0, 10);
    if (typeof v === 'number') return msToDate(v);
    return '';
  };

  return {
    num: typeof f.Num === 'number' ? f.Num : (parseInt(f.Num) || 0),
    date: toDateStr(f.Date),
    company: f.Company || '',
    role: f.Role || '',
    score: f.Score || 'N/A',
    status,
    pdf: f.PDF === true ? '✅' : '❌',
    url: f.URL || '',
    report: f.Report || '—',
    notes: f.Notes || '',
    closedAt: toDateStr(f['Closed At']),
    linked: {},
    _recordId: record.record_id || record.id,
  };
}

function normalizedToFields(rec) {
  const f = {};
  if (rec.num !== undefined && rec.num !== null) f.Num = Number(rec.num);
  if (rec.date) {
    const dateStr = dateToUpsertString(rec.date);
    if (dateStr) f.Date = dateStr;
  }
  if (rec.company !== undefined) f.Company = rec.company;
  if (rec.role !== undefined) f.Role = rec.role;
  if (rec.score !== undefined) f.Score = rec.score;
  if (rec.status !== undefined) {
    if (rec.status && !CANONICAL_STATES.includes(rec.status)) {
      throw new Error(`Non-canonical status "${rec.status}"; must be one of ${CANONICAL_STATES.join(', ')}`);
    }
    f.Status = rec.status;
  }
  if (rec.pdf !== undefined) f.PDF = rec.pdf === '✅' || rec.pdf === true;
  if (rec.report !== undefined) f.Report = rec.report;
  if (rec.notes !== undefined) f.Notes = rec.notes;
  if (rec.url !== undefined) f.URL = rec.url;
  if (rec.closedAt !== undefined && rec.closedAt !== '') {
    const s = dateToUpsertString(rec.closedAt);
    if (s) f['Closed At'] = s;
  }
  return f;
}

// ---- Public factory ----

export function create(cfg) {
  const bitable = cfg.bitable || {};
  const appToken = bitable.app_token;
  const tableId = bitable.table_id_applications;

  if (!appToken || !tableId) {
    throw new Error(
      `tracker.bitable not configured. Run \`npm run tracker:setup\` to initialize.\n` +
      `Current: app_token="${appToken}" table_id_applications="${tableId}"`
    );
  }

  async function listRaw() {
    // +record-list response shape (columnar):
    //   data.data[]          — row arrays; each row is [v0, v1, ...] aligned with fields[]
    //   data.fields[]        — ordered field names
    //   data.record_id_list  — parallel array of record IDs (recXXX)
    //   data.has_more        — pagination signal
    // CLI flags: --limit (default 100) + --offset
    const LIMIT = 100;
    const SAFETY_CAP = 5000;  // 50 pages
    const all = [];
    let offset = 0;

    while (offset < SAFETY_CAP) {
      const out = runLarkCli([
        'base', '+record-list',
        '--base-token', appToken,
        '--table-id', tableId,
        '--limit', String(LIMIT),
        '--offset', String(offset),
        '--format', 'json',  // lark-cli >=1.0.48 defaults to markdown output; force JSON
      ]);
      const parsed = parseJsonOut(out);
      const data = parsed?.data || {};
      const rows = Array.isArray(data.data) ? data.data : [];
      const fieldNames = Array.isArray(data.fields) ? data.fields : [];
      const recordIds = Array.isArray(data.record_id_list) ? data.record_id_list : [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const fields = {};
        for (let j = 0; j < fieldNames.length; j++) {
          fields[fieldNames[j]] = row[j];
        }
        all.push({ record_id: recordIds[i], fields });
      }

      if (!data.has_more || rows.length === 0) break;
      offset += LIMIT;
    }

    return all;
  }

  return {
    async listApplications() {
      const raw = await listRaw();
      return raw.map(recordToNormalized);
    },

    async addApplication(rec) {
      const existing = await this.findByCompanyRole(rec.company, rec.role);
      if (existing) {
        return { num: existing.num, inserted: false };
      }

      // Assign tracker # if not provided
      let num = rec.num;
      if (!num || num <= 0) {
        const maxNum = await this.getMaxNum();
        num = maxNum + 1;
      }

      // Auto-set Closed At when new record is already in terminal status
      const today = new Date().toISOString().slice(0, 10);
      const withClosed = { ...rec, num };
      if (!withClosed.closedAt && isTerminal(withClosed.status)) {
        withClosed.closedAt = today;
      }

      // --json is a FLAT object with field names as top-level keys (no `fields:` wrapper).
      const fields = normalizedToFields(withClosed);
      const payload = JSON.stringify(fields);

      runLarkCli([
        'base', '+record-upsert',
        '--base-token', appToken,
        '--table-id', tableId,
        '--json', payload,
      ], { write: true });

      return { num, inserted: true };
    },

    async updateApplication(num, updates) {
      const all = await listRaw();
      const existing = all.find(r => (r.fields?.Num ?? r.fields?.['#']) === num);
      if (!existing) {
        throw new Error(`#${num} not found in Bitable table ${tableId}`);
      }
      const recordId = existing.record_id || existing.id;

      // Auto-set Closed At on terminal transition if caller didn't set it + not already set
      const withClosed = { ...updates };
      const existingClosedAt = existing.fields?.['Closed At'];
      if (updates.status && isTerminal(updates.status) && !updates.closedAt && !existingClosedAt) {
        withClosed.closedAt = new Date().toISOString().slice(0, 10);
      }

      const fields = normalizedToFields(withClosed);
      runLarkCli([
        'base', '+record-upsert',
        '--base-token', appToken,
        '--table-id', tableId,
        '--record-id', recordId,
        '--json', JSON.stringify(fields),
      ], { write: true });
    },

    /**
     * Update many records in one pass.
     *
     * updateApplication() re-lists the whole table on every call just to turn a
     * business `num` into a Bitable `record_id`. That is fine for one edit and
     * ruinous for a bulk pass: 240 updates meant ~240 full listings (3 pages
     * each) at ~5 req/s. Here we list once, build the num -> record_id index,
     * and hand the writes to +record-batch-update.
     *
     * @param records  [{num, ...fields}]  — `num` selects the row, the rest is
     *                                       the same normalized shape as
     *                                       updateApplication's `updates`.
     * @returns {updated, missing[]}       — `missing` lists nums not in the table
     *                                       (reported, not thrown: a bulk pass
     *                                       should not abort on one stale row).
     */
    async updateMany(records) {
      if (!records || records.length === 0) return { updated: 0, missing: [] };

      const all = await listRaw();
      const index = new Map();
      for (const r of all) {
        const n = r.fields?.Num ?? r.fields?.['#'];
        if (n !== undefined && n !== null && n !== '') index.set(Number(n), r);
      }

      const today = new Date().toISOString().slice(0, 10);
      const payload = [];
      const missing = [];

      for (const rec of records) {
        const existing = index.get(Number(rec.num));
        if (!existing) { missing.push(rec.num); continue; }

        const { num, ...updates } = rec;
        const withClosed = { ...updates };
        // Same terminal-transition rule as updateApplication, so a bulk pass and
        // a single edit cannot disagree about Closed At.
        if (updates.status && isTerminal(updates.status) && !updates.closedAt && !existing.fields?.['Closed At']) {
          withClosed.closedAt = today;
        }
        payload.push({
          record_id: existing.record_id || existing.id,
          fields: normalizedToFields(withClosed),
        });
      }

      // 500 records/request is the documented ceiling; sleep between batches.
      const BATCH = 500;
      for (let i = 0; i < payload.length; i += BATCH) {
        const slice = payload.slice(i, i + BATCH);
        runLarkCli([
          'base', '+record-batch-update',
          '--base-token', appToken,
          '--table-id', tableId,
          '--json', JSON.stringify(slice),
        ], { write: true, timeoutMs: 120000 });
        if (i + BATCH < payload.length) {
          const until = Date.now() + 1000;
          while (Date.now() < until) { /* 1s between batches */ }
        }
      }

      return { updated: payload.length, missing };
    },

    async findByCompanyRole(company, role) {
      const apps = await this.listApplications();
      const normC = normalizeCompany(company);
      return apps.find(a => {
        if (normalizeCompany(a.company) !== normC) return false;
        return roleFuzzyMatch(role, a.role);
      }) || null;
    },

    async getMaxNum() {
      const apps = await this.listApplications();
      let max = 0;
      for (const a of apps) if (a.num > max) max = a.num;
      return max;
    },

    async aggregateByStatus() {
      const apps = await this.listApplications();
      const agg = {};
      for (const a of apps) {
        const s = a.status || 'unknown';
        agg[s] = (agg[s] || 0) + 1;
      }
      return agg;
    },

    // Exposed for setup/migration scripts
    _appToken: appToken,
    _tableId: tableId,
    _runLarkCli: runLarkCli,
    _parseJsonOut: parseJsonOut,
  };
}
