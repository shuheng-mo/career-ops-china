#!/usr/bin/env node
// Demo C — 真实面试 461 一面 e2e 重放（interview-studio 全功能真实数据演练）
// 素材：v26 逐字稿（38 问，session 4d6ac115 已切分）；跑在真实 interview-prep 上（用户授权）。
// 收集模式：断言失败不退出，汇入「产品问题清单」（🔴 bug / 🟡 体验 / 🔵 观察）——这正是本脚本的产出。
// 运行：npm run interview:e2e（不进 test:interview——依赖真实数据）
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudioServer } from '../server/server.mjs';
import { createMockAsrProvider } from '../providers/asr/mock.mjs';
import WebSocket from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const CLI = join(REPO, 'tools', 'interview', 'cli.mjs');
const ROOT = join(REPO, 'interview-prep');
const V26 = '4d6ac115-5ca4-425b-8112-dc4cae4e5048';
const REPORT = join(ROOT, 'eval-private', 'taotian-e2e-report.md');

const step = (m) => console.log(`\n▶ ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 收集器 ----------
const issues = { red: [], yellow: [], blue: [] };
const bug = (m) => { issues.red.push(m); console.log(`  🔴 ${m}`); };
const warn = (m) => { issues.yellow.push(m); console.log(`  🟡 ${m}`); };
const note = (m) => { issues.blue.push(m); console.log(`  🔵 ${m}`); };

function cli(args) {
  const out = execFileSync('node', [CLI, ...args, '--json'], { encoding: 'utf8', cwd: REPO });
  const i = out.indexOf('{');
  return JSON.parse(i >= 0 ? out.slice(i) : out);
}

// ---------- 素材 ----------
const qs = JSON.parse(readFileSync(join(ROOT, 'sessions', V26, 'questions.json'), 'utf8')).questions;
const questions = qs.filter((q) => q.kind === 'question' && q.alignment.status !== 'pending'); // 35 问（反问环节 3 问跳过）
const v26Align = new Map(qs.map((q) => [q.question_id, q.alignment.status]));
const qtext = (q) => q.text.split(' / ').map((s) => s.trim()).filter((s) => s && !/^(嗯|啊|对|OK|Okay|嗯嗯|哎|呃|我想一下啊|好)[，。]?$/.test(s) && s.length > 3).join('；') || q.text.split(' / ').pop();

const scoreFor = (blockId) => 2 + (createHash('sha256').update(blockId).digest()[0] % 3); // 确定性 2-4 分

// ---------- 服务 ----------
const srv = await createStudioServer(ROOT, { port: 0, token: 'e2e-taotian' });
const PORT = srv.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
const H = { 'X-Studio-Token': 'e2e-taotian', 'Content-Type': 'application/json' };
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(b || {}) }).then((r) => r.json());
const get = (p) => fetch(BASE + p, { headers: H }).then((r) => r.json());

const statsBefore = cli(['stats']);
const sessionsBefore = new Set((await get('/api/sessions')).sessions.map((s) => s.session_id));

// ================= 第 0 幕 · 考前 Pack =================
step('第 0 幕 · 考前 Pack（P2）');
const pack = cli(['pack', 'build', '--application', '461', '--round', '一面', '--allow-real-tracker']);
if (!pack.pack_id) { bug(`pack build 失败：${JSON.stringify(pack).slice(0, 120)}`); }
else {
  if (!(pack.selected_blocks?.length > 0)) bug('pack selected_blocks 为空');
  if (pack.coverage_gaps?.length !== 0) warn(`覆盖缺口非 0：${pack.coverage_gaps?.length} 条`);
  const hasFresh = JSON.stringify(pack).match(/expired|stale|fresh/) || (pack.warnings || []).some((w) => /重查|过期|新鲜/.test(w));
  if (!hasFresh) warn('10-16 的 report 今天已 >30 天，pack 未出现 freshness 降级提示');
if (!('source' in (await get('/api/sessions')).sessions[0] || {})) note('sessions API 不返回 source 字段（无法区分练习/语音来源，本脚本用 events 特征绕过）');
  console.log(`  pack ${pack.pack_id}：selected ${pack.selected_blocks?.length}，硬闸门 ${pack.hard_gates?.length}，缺口 ${pack.coverage_gaps?.length}`);
}

// ================= 第 1 幕 · 文字练习三模式 =================
step('第 1 幕 · 文字练习三模式重放（P3，35 问原文）');
const PICK5 = ['q002', 'q018', 'q025', 'q029', 'q032'];
const hitMap = [];

// 1a. mock_assisted 全量
{
  const s = await post('/api/practice/start', { mode: 'mock_assisted' });
  for (const q of questions) {
    const text = qtext(q);
    const r = await post(`/api/practice/${s.session_id}/question`, { text });
    const decision = r.decision || (r.blind ? 'blind' : 'unknown');
    const blockId = r.block?.block_id || (r.candidates || [])[0]?.blockId || null;
    hitMap.push({ id: q.question_id, text, decision, blockId, v26: v26Align.get(q.question_id) });
    if (decision === 'hit') {
      if (!r.block?.body) bug(`${q.question_id} hit 但响应无块正文`);
      await post(`/api/practice/${s.session_id}/rate`, { question_ref: r.question_ref, score: scoreFor(blockId), revealed: false });
    } else if (decision === 'candidates') {
      if (JSON.stringify(r).includes('## 30 秒版')) bug(`${q.question_id} candidates 响应泄漏块正文`);
    } else if (decision === 'unknown') {
      if (r.candidates?.length) warn(`${q.question_id} unknown 但返回了候选`);
    }
  }
  const f = await post(`/api/practice/${s.session_id}/finish`, {});
  if (!f.ok) bug(`assisted finish 失败：${JSON.stringify(f).slice(0, 80)}`);
}

// 1b. mock_anchor 5 问
{
  const s = await post('/api/practice/start', { mode: 'mock_anchor' });
  for (const id of PICK5) {
    const q = questions.find((x) => x.question_id === id);
    const r = await post(`/api/practice/${s.session_id}/question`, { text: qtext(q) });
    const body = JSON.stringify(r);
    if (r.block?.body && !r.block.anchors && !body.includes('anchors')) { /* anchors 字段位置待查 */ }
    if (r.block?.body) warn(`${id} anchor 模式返回了完整正文（应只回锚点）`);
    if (r.blockId || r.block?.block_id) await post(`/api/practice/${s.session_id}/rate`, { question_ref: r.question_ref, score: scoreFor(r.block?.block_id || r.blockId), revealed: false });
  }
  await post(`/api/practice/${s.session_id}/finish`, {});
}

// 1c. mock_blind 5 问（零泄漏 + reveal）
{
  const s = await post('/api/practice/start', { mode: 'mock_blind' });
  for (const id of PICK5) {
    const q = questions.find((x) => x.question_id === id);
    const r = await post(`/api/practice/${s.session_id}/question`, { text: qtext(q) });
    const body = JSON.stringify(r);
    if (body.includes('30 秒版') || body.includes('cross-encoder') || r.decision) bug(`${id} 盲测响应泄漏（decision=${r.decision}）`);
    const rv = await post(`/api/practice/${s.session_id}/reveal`, { question_ref: r.question_ref });
    if (!rv.block?.block_id) note(`${id} reveal 后无命中块（知识缺口，非泄漏问题）`);
    if (rv.block?.block_id) await post(`/api/practice/${s.session_id}/rate`, { question_ref: r.question_ref, score: scoreFor(rv.block.block_id), revealed: true });
  }
  await post(`/api/practice/${s.session_id}/finish`, {});
}

const hits = hitMap.filter((h) => h.decision === 'hit').length;
console.log(`  命中地图：${hits}/${hitMap.length} hit`);
const q002 = hitMap.find((h) => h.id === 'q002');
if (q002?.decision !== 'hit') bug(`q002「NN 搜索架构」加 alias 后仍 ${q002?.decision}（预期 hit）`);
const q025 = hitMap.find((h) => h.id === 'q025');
if (q025?.decision !== 'hit') warn(`q025 v26 时 matched，重放为 ${q025?.decision}`);

// ================= 第 2 幕 · 语音链路（mock 脚本化） =================
step('第 2 幕 · 语音链路重放（P4，mock provider 10 问）');
let providerRef = null;
srv.attachWs({ token: 'e2e-taotian', root: ROOT, asrConfig: { createProvider: () => { const p = createMockAsrProvider(); providerRef = p; return p; } } });

function wsOpen() {
  return new Promise((resolve, reject) => {
    const msgs = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/capture?token=e2e-taotian`);
    ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('error', reject);
  });
}
const VOICE10 = ['q002', 'q025', 'q026', 'q027', 'q029', 'q031', 'q032', 'q018', 'q019', 'q040'].map((id) => questions.find((x) => x.question_id === id)).filter(Boolean);
let voiceSessionId = null;
{
  const { ws, msgs } = await wsOpen();
  ws.send(JSON.stringify({ type: 'start', mode: 'mock_assisted' }));
  await sleep(300);
  const hintsBefore = () => msgs.filter((m) => m.type === 'hint').length;
  let hintCount = 0;
  for (const q of VOICE10) {
    await providerRef.pushScript([{ type: 'final', text: qtext(q), segmentId: `v-${q.question_id}` }]);
    await sleep(3200); // 稳定期 2000ms + 防抖/提交余量
    const now = hintsBefore();
    if (now > hintCount) hintCount = now;
  }
  if (hintCount === 0) bug('语音链路 10 问零 hint（fastpath 未触发）');
  else console.log(`  语音链路收到 hint：${hintCount}/10`);
  // 锁定后再推 → 无新 hint
  ws.send(JSON.stringify({ type: 'lock', locked: true }));
  await sleep(200);
  const locked = hintsBefore();
  await providerRef.pushScript([{ type: 'final', text: '锁定后这个问题不应该触发跳转？', segmentId: 'v-locked' }]);
  await sleep(3400);
  if (hintsBefore() > locked) bug('锁定后自动跳转未被禁止');
  else console.log('  锁定语义 ✓（锁定后推送不再触发 hint）');
  ws.send(JSON.stringify({ type: 'stop' }));
  await sleep(600);
  const fin = msgs.find((m) => m.type === 'state' && m.state === 'finished');
  if (!fin) bug('语音链路 stop 后未收到 finished');
  else console.log(`  stop finished ✓ gaps=${fin.gaps}`);
  // 资源释放回归：stop 后再推事件不崩
  await providerRef.pushScript([{ type: 'final', text: '迟到事件', segmentId: 'v-late' }]).catch(() => {});
  await sleep(200);
  ws.close();
}
// 盲测语音连接
{
  const { ws, msgs } = await wsOpen();
  ws.send(JSON.stringify({ type: 'start', mode: 'mock_blind' }));
  await sleep(300);
  await providerRef.pushScript([{ type: 'final', text: qtext(questions.find((q) => q.question_id === 'q025')), segmentId: 'b-1' }]);
  await sleep(3200);
  const hint = msgs.find((m) => m.type === 'hint');
  if (!hint) bug('盲测语音链路无 hint');
  else if (hint.block || hint.decision) bug('盲测语音 hint 泄漏块信息');
  else if (!hint.blind) warn('盲测语音 hint 未带 blind 标记');
  else console.log('  盲测语音 hint ✓（blind 标记、无块内容）');
  ws.send(JSON.stringify({ type: 'stop' }));
  await sleep(400);
  ws.close();
}

// 事件落盘（语音 session）：定位挪到此处——所有 asr.final 已落盘
voiceSessionId = (await (async () => {
  const sess = (await get('/api/sessions')).sessions.filter((s) => !sessionsBefore.has(s.session_id));
  for (const s of sess.reverse()) {
    try {
      const ev = readFileSync(join(ROOT, 'sessions', s.session_id, 'events.jsonl'), 'utf8');
      if (ev.includes('"segmentId":"v-q002"')) return s.session_id; // 主语音场的 segment 特征
    } catch { /* 无 events 的跳过 */ }
  }
  return null;
})());
if (voiceSessionId) {
  const ev = readFileSync(join(ROOT, 'sessions', voiceSessionId, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const asrFinal = ev.filter((e) => e.type === 'asr.final');
  const qDetected = ev.filter((e) => e.type === 'question.detected');
  if (asrFinal.length < 10) bug(`语音 session asr.final 落盘 ${asrFinal.length}/10`);
  if (qDetected.length === 0) bug('语音 session 无 question.detected 事件');
  else if (!qDetected[0].payload?.realtime) warn('question.detected 未带 realtime 标记');
  console.log(`  落盘：asr.final ${asrFinal.length} 条，question.detected ${qDetected.length} 条`);
} else {
  bug('未能定位语音重放 session（sessions API 无新增 studio-voice 记录）');
}

// ================= 第 3 幕 · 面后 =================
step('第 3 幕 · 面后（stats / practice / gap patch）');
const statsAfter = cli(['stats']);
{
  const before = JSON.stringify(statsBefore.blocks || []);
  const after = statsAfter.blocks || [];
  const changed = after.filter((b) => {
    const bf = (statsBefore.blocks || []).find((x) => x.block_id === b.block_id);
    return !bf || JSON.stringify(bf) !== JSON.stringify(b);
  });
  if (changed.length === 0) bug('模拟练习后 stats 无任何变化（rating 未进统计）');
  else console.log(`  stats 变化块数：${changed.length}（${changed.slice(0, 3).map((c) => c.block_id).join('、')}…）`);
  const realPolluted = after.find((b) => b.frequency != null && (statsBefore.blocks || []).find((x) => x.block_id === b.block_id)?.frequency == null);
  if (realPolluted) bug(`mock 练习污染了真实 frequency：${realPolluted.block_id}`);
  void before;
}
{
  const practice = execFileSync('node', [CLI, 'practice'], { encoding: 'utf8', cwd: REPO });
  if (!practice.includes('mo.elytra-contribution')) bug('practice 题单缺少 mo.elytra-contribution');
  else console.log('  practice 题单含目标块 ✓');
}
// gap_add patch：真实面试重放暴露的高频缺口（pending，不 approve——内容待用户深挖）
{
  const gaps = [
    { theme: '华为 NL2SQL 元数据召回重构（q003/q004/q009/q010：重构前后差异、30% 口径、指标定义）', qids: 'q003 q004 q009 q010' },
    { theme: '数仓分层与宽表（q018/q019：DWD vs DWS 职责边界、宽表设计）', qids: 'q018 q019' },
  ];
  for (const g of gaps) {
    const f = `/tmp/gap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    writeFileSync(f, JSON.stringify({
      type: 'gap_add',
      target_id: null,
      proposed_diff: { question: g.theme, source: 'taotian-e2e-replay' },
      reason: `真实面试 461 一面 e2e 重放发现的高频缺口（${g.qids}），待用户补充原话后建块`,
      source_refs: [{ artifact_id: `session ${V26}`, locator: g.qids }],
    }));
    try {
      const r = cli(['patch', 'propose', '--file', f]);
      console.log(`  gap patch 提案：${r.patch_id}（pending）`);
    } catch (e) {
      const msg = String(e.stdout || '') + String(e.message || e);
      if (msg.includes('重复提案')) note(`gap patch「${g.theme.slice(0, 20)}…」上轮已提（幂等跳过）`);
      else bug(`gap_add patch propose 失败：${msg.slice(0, 120)}`);
    }
  }
}

// ================= 报告 =================
step('写报告');
mkdirSync(dirname(REPORT), { recursive: true });
const newSessions = (await get('/api/sessions')).sessions.filter((s) => !sessionsBefore.has(s.session_id));
const lines = [];
lines.push('# 真实面试 461 一面 e2e 重放报告', '', `生成：${new Date().toISOString()} · 素材：v26 逐字稿 35 问（原文含转写噪声）· 数据层：真实 interview-prep`, '');
lines.push('## 命中地图（mock_assisted 全量 35 问）', '', '| 问 | 检索 | 命中块 | v26 真实 |', '|---|---|---|---|');
for (const h of hitMap) lines.push(`| ${h.id} | ${h.decision} | ${h.blockId || '—'} | ${h.v26} |`);
lines.push('', `- hit：${hits}/${hitMap.length}；unknown/candidates 为知识库真实缺口（华为 NL2SQL 细节、开放设计题为主）`);
lines.push(`- 本轮新增 session：${newSessions.length} 条（预期 4：assisted/anchor/blind/voice×2 实际 ${newSessions.map((s) => s.mode).join(',')}）`, '');
lines.push('## 产品问题清单', '');
lines.push(`### 🔴 bug（${issues.red.length}）`);
issues.red.forEach((m, i) => lines.push(`${i + 1}. ${m}`));
if (!issues.red.length) lines.push('（无）');
lines.push('', `### 🟡 体验问题（${issues.yellow.length}）`);
issues.yellow.forEach((m, i) => lines.push(`${i + 1}. ${m}`));
if (!issues.yellow.length) lines.push('（无）');
lines.push('', `### 🔵 观察记录（${issues.blue.length}）`);
issues.blue.forEach((m, i) => lines.push(`${i + 1}. ${m}`));
if (!issues.blue.length) lines.push('（无）');
lines.push('', '## 人工环节（需要用户在场，不阻塞脚本）', '',
  '- [ ] 真实 ASR 抽检：`npm run interview:studio` → 语音模式念 5 个 v26 问题（q002/q018/q025/q029/q032），对照本文命中地图',
  '- [ ] 浏览器过六页面：token 登录、知识库编辑、Settings、Heatmap、Replay',
  '- [ ] gap patch 两个提案补原话后 approve（patch list 查看）');
writeFileSync(REPORT, lines.join('\n'));

console.log(`\n✅ Demo C 完成：报告 ${REPORT}`);
console.log(`问题汇总：🔴 ${issues.red.length} · 🟡 ${issues.yellow.length} · 🔵 ${issues.blue.length}`);

srv.closeAllConnections();
await new Promise((r) => srv.close(r));
process.exit(0);
