/**
 * md-backend.mjs — applications.md backend.
 *
 * Wraps the existing markdown table format. Core parse logic is lifted from
 * tools/merge-tracker.mjs (parseAppLine) and tools/verify-pipeline.mjs.
 *
 * Not re-entrant: each method re-reads applications.md each call. That's
 * intentional — the file can be edited by users between calls and we want
 * to see fresh state. Callers that need consistency should cache the list.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CAREER_OPS, normalizeCompany, roleFuzzyMatch, isTerminal } from '../tracker-backend.mjs';

// Support both layouts: data/applications.md (current) and applications.md (legacy boilerplate)
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');

function readAll() {
  if (!existsSync(APPS_FILE)) return { lines: [], apps: [], maxNum: 0 };

  const content = readFileSync(APPS_FILE, 'utf-8');
  const lines = content.split('\n');
  const apps = [];
  let maxNum = 0;

  for (const line of lines) {
    if (!line.startsWith('|') || line.includes('---') || /\|\s*#\s*\|/.test(line)) continue;
    const rec = parseAppLine(line);
    if (rec) {
      apps.push(rec);
      if (rec.num > maxNum) maxNum = rec.num;
    }
  }

  return { lines, apps, maxNum };
}

// Columns layout (11 cols, 2026-04-20 extended):
//   | # | Date | Company | Role | Score | Status | PDF | URL | Report | Notes | Closed At |
// Legacy layout (9 cols) is still parsed for backward compat; missing URL/Closed At
// default to ''. formatLine always emits 11 cols.
function parseAppLine(line) {
  const parts = line.split('|').map(s => s.trim());
  // Split on `|` yields 2 extra empty cells (leading + trailing). Real cell count = parts.length - 2.
  //   9-col legacy layout  → parts.length === 11
  //   11-col extended      → parts.length === 13
  const cellCount = parts.length - 2;
  if (cellCount < 9) return null;
  const num = parseInt(parts[1]);
  if (isNaN(num) || num === 0) return null;

  const hasExtended = cellCount >= 11;
  return {
    num,
    date: parts[2],
    company: parts[3],
    role: parts[4],
    score: parts[5],
    status: parts[6],
    pdf: parts[7],
    url: hasExtended ? parts[8] : '',
    report: hasExtended ? parts[9] : parts[8],
    notes: hasExtended ? (parts[10] || '') : (parts[9] || ''),
    closedAt: hasExtended ? (parts[11] || '') : '',
    linked: {},
    _raw: line,
  };
}

function formatLine(rec) {
  return `| ${rec.num} | ${rec.date} | ${rec.company} | ${rec.role} | ${rec.score} | ${rec.status} | ${rec.pdf} | ${rec.url || ''} | ${rec.report} | ${rec.notes} | ${rec.closedAt || ''} |`;
}

export function create(_cfg) {
  return {
    async listApplications() {
      return readAll().apps;
    },

    async addApplication(rec) {
      // Reject if dup by company+role (per CLAUDE.md rule)
      const existing = await this.findByCompanyRole(rec.company, rec.role);
      if (existing) {
        return { num: existing.num, inserted: false };
      }

      const { lines, maxNum } = readAll();
      const num = rec.num && rec.num > maxNum ? rec.num : maxNum + 1;

      const status = rec.status || 'Evaluated';
      const today = new Date().toISOString().slice(0, 10);
      const newRec = {
        num,
        date: rec.date || today,
        company: rec.company || '',
        role: rec.role || '',
        score: rec.score || 'N/A',
        status,
        pdf: rec.pdf || '❌',
        url: rec.url || '',
        report: rec.report || '—',
        notes: rec.notes || '',
        // Auto-set Closed At when added with terminal status
        closedAt: rec.closedAt || (isTerminal(status) ? today : ''),
      };
      const newLine = formatLine(newRec);

      // Insert after the header separator line (the one with ---)
      let insertIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('|') && lines[i].includes('---')) {
          insertIdx = i + 1;
          break;
        }
      }
      if (insertIdx < 0) {
        throw new Error('applications.md missing table header separator');
      }
      lines.splice(insertIdx, 0, newLine);
      writeFileSync(APPS_FILE, lines.join('\n'));

      return { num, inserted: true };
    },

    async updateApplication(num, fields) {
      const { lines, apps } = readAll();
      const existing = apps.find(a => a.num === num);
      if (!existing) {
        throw new Error(`#${num} not found in applications.md`);
      }

      const updated = { ...existing, ...fields };
      // Auto-set Closed At on terminal transition if caller didn't set it explicitly
      if (fields.status && isTerminal(fields.status) && !fields.closedAt && !existing.closedAt) {
        updated.closedAt = new Date().toISOString().slice(0, 10);
      }
      const updatedLine = formatLine(updated);
      const idx = lines.indexOf(existing._raw);
      if (idx < 0) {
        throw new Error(`Failed to locate line for #${num}`);
      }
      lines[idx] = updatedLine;
      writeFileSync(APPS_FILE, lines.join('\n'));
    },

    async findByCompanyRole(company, role) {
      const { apps } = readAll();
      const normC = normalizeCompany(company);
      return apps.find(a => {
        if (normalizeCompany(a.company) !== normC) return false;
        return roleFuzzyMatch(role, a.role);
      }) || null;
    },

    async getMaxNum() {
      return readAll().maxNum;
    },

    async aggregateByStatus() {
      const { apps } = readAll();
      const agg = {};
      for (const a of apps) {
        const s = a.status || 'unknown';
        agg[s] = (agg[s] || 0) + 1;
      }
      return agg;
    },
  };
}
