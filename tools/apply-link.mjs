#!/usr/bin/env node
/**
 * apply-link.mjs — 校验「企业官网投递链接」是否还在招。
 *
 * 线索平台（神仙外企等）转载的官网链接时效没有保证：平台上还挂着，官网可能早已下线。
 * 这里按 ATS 分别处理，能用公开接口确认的就确认，确认不了的如实标 unverified：
 *
 *   Workday          /wday/cxs/{tenant}/{site}/job/... → 200 在招，403/404/410 已下线
 *   SmartRecruiters  api.smartrecruiters.com/v1/companies/{co}/postings/{id} → 200 在招，4xx 已下线
 *   其他             普通 GET：404/410 或页面含「已下线/no longer available」类文案 → 已下线；
 *                    否则 unverified（多为 SPA 壳页，HTTP 200 不代表岗位还在，如 Moka 的 #/job 路由）
 *
 *   node tools/apply-link.mjs <url>                     # 查单个链接
 *   node tools/apply-link.mjs inbox/processed/jd-*.json  # 查 inbox JSON（用 apply_url，没有则用 url）
 *
 * 状态：live（接口确认在招） / closed（确认下线） / unverified（打得开但无法确认） / none（无链接） / error
 * 退出码：有任一 closed 时为 2，便于脚本判断；其余为 0。
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const TIMEOUT_MS = 15000;
const CLOSED_TEXT = /职位已(下线|关闭|失效|结束|过期)|该职位(已|不存在)|岗位已(下线|关闭|失效)|招聘已结束|no longer (available|accepting|open)|position (has been )?(filled|closed)|job (posting )?(is )?(closed|expired|no longer)|this job (has )?expired/i;

/** 从「链接请在微信端打开:https://...」这类字段里抠出第一个 URL。 */
export function extractUrl(raw) {
  return String(raw || '').match(/https?:\/\/[^\s"'<>，。]+/)?.[0] || null;
}

async function get(url, init = {}) {
  return fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), ...init, headers: { 'User-Agent': UA, ...init.headers } });
}

async function checkWorkday(u) {
  // https://{tenant}.wdN.myworkdayjobs.com/[en-US/]{site}/job/{rest}
  const parts = u.pathname.split('/').filter(Boolean);
  if (/^[a-z]{2}-[A-Z]{2}$/.test(parts[0])) parts.shift();
  const jobIdx = parts.indexOf('job');
  if (jobIdx < 1) return null;
  const tenant = u.hostname.split('.')[0];
  const api = `${u.origin}/wday/cxs/${tenant}/${parts[0]}/${parts.slice(jobIdx).join('/')}`;
  const res = await get(api, { headers: { Accept: 'application/json' } });
  if (res.ok) {
    const info = (await res.json().catch(() => ({}))).jobPostingInfo;
    if (info) return { status: info.canApply === false ? 'closed' : 'live', via: 'workday', http: res.status };
    return { status: 'unverified', via: 'workday', http: res.status };
  }
  if ([403, 404, 410].includes(res.status)) return { status: 'closed', via: 'workday', http: res.status };
  return { status: 'unverified', via: 'workday', http: res.status };
}

async function checkSmartRecruiters(u) {
  // https://jobs.smartrecruiters.com/{company}/{postingId}-{slug}
  const [company, posting] = u.pathname.split('/').filter(Boolean);
  const id = posting?.match(/^\d+/)?.[0];
  if (!company || !id) return null;
  const res = await get(`https://api.smartrecruiters.com/v1/companies/${company}/postings/${id}`, { headers: { Accept: 'application/json' } });
  if (res.ok) return { status: 'live', via: 'smartrecruiters', http: res.status };
  if (res.status >= 400 && res.status < 500) return { status: 'closed', via: 'smartrecruiters', http: res.status };
  return { status: 'unverified', via: 'smartrecruiters', http: res.status };
}

async function checkGeneric(url) {
  let res;
  try { res = await get(url); }
  // Moka 等站点靠 cookie 302 循环挡非浏览器请求：打不开 ≠ 已下线，只能交给人工/浏览器确认
  catch (e) { return { status: 'unverified', via: 'http', error: `需浏览器打开确认（${e.cause?.message || e.message}）` }; }
  if ([404, 410].includes(res.status)) return { status: 'closed', via: 'http', http: res.status };
  if (!res.ok) return { status: 'unverified', via: 'http', http: res.status };
  const body = (await res.text().catch(() => '')).replace(/<script[\s\S]*?<\/script>/gi, '').slice(0, 200000);
  if (CLOSED_TEXT.test(body)) return { status: 'closed', via: 'http-text', http: res.status };
  return { status: 'unverified', via: 'http', http: res.status };
}

/** @returns {Promise<{url: string|null, status: 'live'|'closed'|'unverified'|'none'|'error', via?: string, http?: number, error?: string}>} */
export async function checkApplyLink(raw) {
  const url = extractUrl(raw);
  if (!url) return { url: null, status: 'none' };
  try {
    const u = new URL(url);
    let r = null;
    if (u.hostname.endsWith('.myworkdayjobs.com')) r = await checkWorkday(u);
    else if (u.hostname === 'jobs.smartrecruiters.com') r = await checkSmartRecruiters(u);
    return { url, ...(r || await checkGeneric(url)) };
  } catch (e) {
    return { url, status: 'error', error: e.message };
  }
}

// ---------- CLI ----------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('用法：node tools/apply-link.mjs <url | inbox JSON 路径> [...]');
    process.exit(1);
  }
  const icon = { live: '🟢', closed: '🔴', unverified: '🟡', none: '⚪', error: '❌' };
  let closed = 0;
  for (const arg of args) {
    let target = arg, label = arg;
    if (arg.endsWith('.json') && fs.existsSync(arg)) {
      const j = JSON.parse(fs.readFileSync(arg, 'utf8'));
      target = j.apply_url || j.url;
      label = `${j.extracted?.company || ''} | ${j.extracted?.job_title || ''}`;
    }
    const r = await checkApplyLink(target);
    if (r.status === 'closed') closed++;
    console.log(`${icon[r.status]} ${r.status.padEnd(10)} ${label}\n   ${r.url || '(无链接)'}${r.via ? `  [${r.via}${r.http ? ` ${r.http}` : ''}]` : ''}${r.error ? `  ${r.error}` : ''}`);
  }
  process.exit(closed ? 2 : 0);
}
