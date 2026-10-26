#!/usr/bin/env node
/**
 * radar-seen.mjs — the "already seen" list for the cloud radar routines.
 *
 * The radar routines run in the cloud against the public repo, where the tracker is
 * not present (it is gitignored: company names + application state are personal). So
 * they cannot dedupe, and on 2026-10-25 7 of 15 leads were roles the tracker already
 * had. The fix is to put the seen list into the routine prompt itself — the prompt is
 * private configuration, never committed. This prints that block.
 *
 * Grouped by company, one line each: 「公司：岗位#N、岗位#N」. Parenthesised qualifiers
 * (city, department) are dropped and each company shows at most 8 roles (「另 N 个」 for
 * the rest): the prompt only needs enough to recognise a repeat, and one large employer
 * alone has dozens of rows. Rows rejected for location are skipped entirely.
 *
 * Usage: node tools/radar-seen.mjs --direction ai|auto [--since YYYY-MM-DD]   (since default: 2026-09-01)
 * Each radar routine covers one direction, so each gets only its own half of the list
 * (by the Track column). Paste the output into that routine's prompt — see modes/radar.md 「去重清单」.
 */

import { listApplications, trackDirection } from './tracker-backend.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const since = arg('--since') || '2026-09-01';
const direction = String(arg('--direction') || '').toUpperCase();
if (!['AI', 'AUTO'].includes(direction)) {
  console.error('usage: node tools/radar-seen.mjs --direction ai|auto [--since YYYY-MM-DD]');
  process.exit(1);
}

const strip = s => String(s || '').replace(/（[^）]*）|\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();

const apps = (await listApplications())
  .filter(a => String(a.date || '') >= since && Number(a.num) > 0)
  .filter(a => trackDirection(a.track) === direction)
  // Rows dropped for being outside 江浙沪 can never come back from the radar (its prompt
  // excludes those cities), so they only take room from the roles that can.
  .filter(a => !/^区域[:：]/.test(String(a.notes || '').trim()))
  .sort((a, b) => Number(b.num) - Number(a.num));

// The radar only ever reports AI / data / cockpit roles, so within a company those are
// the ones worth showing when the list has to be cut.
const RELEVANT = /AI|大模型|Agent|智能体|LLM|数据|座舱|算法|NL2SQL|RAG/i;

const byCompany = new Map();
for (const a of apps) {
  const company = strip(a.company);
  if (!company) continue;
  if (!byCompany.has(company)) byCompany.set(company, []);
  byCompany.get(company).push(a);
}
for (const [company, rows] of byCompany) {
  rows.sort((x, y) => RELEVANT.test(y.role) - RELEVANT.test(x.role) || Number(y.num) - Number(x.num));
  byCompany.set(company, rows.map(a => `${strip(a.role).slice(0, 14)}#${a.num}`));
}

console.log(`<!-- 生成于 ${new Date().toLocaleDateString('sv-SE')}，${direction} 方向，tracker ${since} 起 ${apps.length} 条，${byCompany.size} 家公司 -->`);
const MAX_ROLES = 8;
for (const [company, roles] of byCompany) {
  const more = roles.length > MAX_ROLES ? `、另 ${roles.length - MAX_ROLES} 个（该公司已整页看过）` : '';
  console.log(`${company}：${roles.slice(0, MAX_ROLES).join('、')}${more}`);
}
