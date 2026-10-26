/**
 * cv-facts.mjs — fact extraction and the fact ledger, shared by cv-sync-check and cv-version.
 *
 * Two ways of seeing "facts" in a CV, used for different jobs:
 *
 *   extractNumbers(text)  every digit run. Exhaustive, so it is the right tool for the
 *                         subset rule in sync-check ("a variant may not state a number
 *                         cv.md lacks"). Too coarse for anything else: "12" matches
 *                         "8 节点" and "8 张表" alike.
 *
 *   extractClaims(text)   number + the unit right after it ("85%", "8节点", "30秒").
 *                         This is what a reader actually takes away as a claim, so it is
 *                         what the ledger tracks and what `cv-version affected` searches
 *                         tailored CVs for. Dates, years and list markers carry no unit
 *                         and fall out naturally.
 *
 * The ledger (cv-evolve/ledger.yml) is parsed with a deliberately tiny reader rather
 * than a YAML dependency: the file is written by Claude in a fixed flat shape (see
 * templates/evolve/ledger.example.yml) and the project has no yaml package.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const EVOLVE_DIR = join(ROOT, 'cv-evolve');
export const LEDGER_PATH = join(EVOLVE_DIR, 'ledger.yml');

// Strip fenced code and inline code: a snippet's literals are not CV claims.
function prose(text) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

export function extractNumbers(text) {
  const out = new Set();
  for (const m of prose(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/,/g, '').replace(/\.$/, '');
    if (n) out.add(n);
  }
  return out;
}

// Bold markers and spaces are formatting, not content: "**8 节点**" and "8节点" are
// the same claim.
const flatten = s => s.replace(/\*+/g, '').replace(/[\s　]+/g, '');

const YEAR_OR_DATE = /^(19|20)\d\d(\.\d{1,2})?$/;

// A whitelist, longest first. Grabbing "any 1-2 CJK chars" turned "15 张业务表" into the
// claim "15张业" and "5G" into a number; a unit list is what keeps claims readable.
const UNITS = [
  '毫秒', '小时', '分钟', '节点', '字段', '个月',
  'QPS', 'TPS', 'ms',
  '%', '％', '倍', '秒', '轮', '张', '个', '条', '人', '万', '亿', '次', '份', '家', '天',
  '周', '项', '门', '层', '名', '类', '篇', '套', '页', '行', '元',
  'k', 'K', 'w', 'W', 'x', 'B', 'M',
];
// A Latin unit must end the token ("7B", not the "B" of "7Bytes"); a CJK unit may be
// followed by anything ("30个工具" is the claim "30个").
const UNIT_RE = UNITS
  .map(u => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (/^[A-Za-z]+$/.test(u) ? '(?![A-Za-z])' : ''))
  .join('|');
const CLAIM_RE = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)(\\+?)(${UNIT_RE})`, 'g');

export function extractClaims(text) {
  const out = new Set();
  for (const m of flatten(prose(text)).matchAll(CLAIM_RE)) {
    const num = m[1].replace(/,/g, '');
    if (YEAR_OR_DATE.test(num)) continue;
    out.add(num + m[2] + m[3].replace('％', '%'));
  }
  return out;
}

export function textContainsClaim(text, claim) {
  return flatten(prose(text)).includes(claim);
}

function scalar(raw) {
  const v = raw.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(',').map(scalar).filter(x => x !== '') : [];
  }
  const q = v.match(/^"(.*)"$/) || v.match(/^'(.*)'$/);
  return q ? q[1] : v;
}

export function parseLedger(text) {
  const entries = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue;
    const start = line.match(/^-\s+(\w+):\s*(.*)$/);
    const cont = line.match(/^\s+(\w+):\s*(.*)$/);
    if (start) {
      cur = { [start[1]]: scalar(start[2]) };
      entries.push(cur);
    } else if (cont && cur) {
      cur[cont[1]] = scalar(cont[2]);
    }
  }
  return entries;
}

export function readLedger() {
  return existsSync(LEDGER_PATH) ? parseLedger(readFileSync(LEDGER_PATH, 'utf-8')) : null;
}
