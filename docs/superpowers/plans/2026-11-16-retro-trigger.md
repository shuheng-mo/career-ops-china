# 复盘线自动触发 + 复盘报告草稿 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每天自动算「两周正面回复率 vs 基准月」，跌破就用独立飞书消息 + 加急必达提醒，`npm run retro` 生成给 Claude 读的复盘报告草稿。

**Architecture:** 纯计算放 `tools/retro-core.mjs`（指标、窗口、状态机，无 I/O 副作用以外的依赖），被 pulse / 日报 / 9:00 检查 / retro 报告四处复用。提醒发送放 `tools/feishu/retro-alert.mjs`，发送函数可注入以便测试。报告渲染放 `tools/retro.mjs`。

**Tech Stack:** Node.js ESM（.mjs），零新依赖；lark-cli 只经 `tools/feishu/capabilities.mjs` 的 `runLarkCli()`；测试为独立脚本 + `node:assert/strict`。

**Spec:** `docs/superpowers/specs/2026-11-16-retro-trigger-design.md`

## Global Constraints

- 数据只经 `listApplications()`（`tools/tracker-backend.mjs`）读取
- 正面回复 = `firstResponse ∈ {HR沟通, 约面}` 或 `furthestStage` 非空且 ≠ `未面`；**拒信不算**
- 窗口 = `appliedAt ∈ [today-27, today-14]`；n < 10 时起点每次 −7 天，最远 `today-55`；仍 < 10 → `insufficient`
- 触发 = 窗口正面率 **严格小于** 基准正面率；基准月来自 `config/profile.yml` 的 `retro.baseline_month`，每次现算
- 已完成复盘 = `data/retro/*-retro.md` 中不含 `待 Claude 与用户填写` 的文件；冷却 14 天
- 日期一律北京时间 `YYYY-MM-DD`；`appliedAt` 等字段先 `String(x).slice(0, 10)` 归一
- 新 capability 名 `retro_alert`；不复用 `im_card`
- 永不自行加 `--yes`、不自行开通 scope；缺 scope 只打印提示
- 公开仓库：被跟踪文件里不出现真实公司名 / 投递编号 / 个人信息；运行产物只进 `data/retro/`（已 gitignored）
- 不提交、不推送，除非用户要求

## Review Focus

1. `appliedAt` / `firstResponseAt` 带时间部分（`2026-11-13 00:00:00`）或为空 → 按日期正常归入窗口，不抛错（Task 1 测试 `dates with time part`）
2. tracker 的 `report` 为 `—`、空、或指向已删除文件 → 可达性 / Tier 记「未标注」，报告照常生成（Task 3 测试 `missing report file`）
3. 当天已经发过提醒后再次运行（launchd + 手动 `--dry-run` 之外的重复运行）→ 不重复发消息、不重复加急（Task 2 测试 `same-day rerun`）
4. 消息发出但加急失败（多半缺 scope）→ 仍弹系统通知、写 reminders、记 `lastSent`，日志写明原因（Task 2 测试 `urgent fails`）
5. 同日重复 `npm run retro` → 无 `--force` 拒绝覆盖，退出码非 0；生成的草稿不会解除提醒（Task 1 测试 `draft does not resolve` + Task 3 测试 `refuse overwrite`）

---

### Task 1: 复盘线计算与状态机（`retro-core.mjs`）

**Files:**
- Create: `tools/retro-core.mjs`
- Create: `tools/test-retro.mjs`
- Modify: `package.json`（scripts 加 `"test:retro": "node tools/test-retro.mjs"`）
- Modify: `config/profile.yml`、`config/profile.example.yml`（新增顶层块 `retro:\n  baseline_month: "2026-04"`，example 里带注释说明含义）

**Interfaces:**
- Produces（全部 named export）：
  - `RETRO_DIR: string`（`<repo>/data/retro`）、`PLACEHOLDER = '待 Claude 与用户填写'`、`COOLDOWN_DAYS = 14`、`MIN_N = 10`
  - `todayBJ(): string`；`day(s: any): string`（slice 归一，空 → `''`）；`daysBetween(a: string, b: string): number`
  - `isPositive(app): boolean`；`responseKind(app): '拒信'|'HR沟通'|'约面'|'无'`（无 `firstResponse` 但有越过 `未面` 的 `furthestStage` → `约面`）
  - `matured(apps, today): app[]` —— 有 `appliedAt` 且 `daysBetween(appliedAt, today) >= 14`
  - `retroWindow(apps, today): { from, to, rows, n, pos, enough: boolean }`
  - `baseline(apps, month, today): { month, rows, n, pos, rate }`（只算满 14 天的）
  - `readRetroConfig(): { baselineMonth: string|null }`（手写解析，照 `capabilities.mjs` 的 `readProfileFeishu` 风格，只认 `^retro:` 块下 `  baseline_month:`）
  - `retroLine(apps, { today, baselineMonth }): { status: 'below'|'ok'|'insufficient'|'no-baseline', window, base, rate, baseRate }`
  - `listRetros(dir = RETRO_DIR): Array<{ file, date, completed }>`（文件名 `^(\d{4}-\d{2}-\d{2}).*-retro\.md$`，按日期升序）
  - `lastCompleted(retros): string|null`；`cooldownUntil(retros): string|null`（最近完成日 + 14 天）
  - `readAlertState() / writeAlertState(state)`，文件 `data/retro/.alert-state.json`，形状 `{ active, firstTriggered, lastSent, messageId }`
  - `decideAlert({ line, retros, state, today }): { action: 'alert'|'already-sent'|'cooldown'|'resolved'|'none', state, streak }`

- [ ] **Step 1: 写失败测试 `tools/test-retro.mjs`**（用 `node:assert/strict`，造 `app` 对象，字段同 `listApplications()` 输出；每个 case 打印 ✓/✗，任一失败 `process.exit(1)`）

```js
// isPositive / responseKind
assert.equal(isPositive({ firstResponse: '拒信' }), false);
assert.equal(isPositive({ firstResponse: 'HR沟通' }), true);
assert.equal(isPositive({ furthestStage: '一面' }), true);
assert.equal(isPositive({ furthestStage: '未面' }), false);
assert.equal(responseKind({ furthestStage: '二面' }), '约面');
// dates with time part
const T = '2026-11-16';
const mk = (age, extra = {}) => ({ appliedAt: shift(T, -age) + ' 00:00:00', ...extra }); // shift = 测试内小工具
assert.equal(retroWindow([mk(14), mk(27), mk(13), mk(28)], T).n, 2);   // 只含 14..27
// window extension: 3 rows in [14,27], 8 more at age 30 → 扩一次到 [14,34]，n=11，enough
const w = retroWindow([...Array(3)].map(() => mk(20)).concat([...Array(8)].map(() => mk(30))), T);
assert.equal(w.n, 11); assert.equal(w.from, shift(T, -34)); assert.equal(w.enough, true);
// cap at 55
assert.equal(retroWindow([mk(56), mk(20)], T).enough, false);
// retroLine strict-below
// baseline month: fixed made-up counts; window under it → below; window at equal rate → ok
// decideAlert
const below = { status: 'below' };
let d = decideAlert({ line: below, retros: [], state: {}, today: T });
assert.equal(d.action, 'alert'); assert.equal(d.state.firstTriggered, T); assert.equal(d.streak, 1);
// same-day rerun
d = decideAlert({ line: below, retros: [], state: { ...d.state, lastSent: T }, today: T });
assert.equal(d.action, 'already-sent');
// next day streak 2
d = decideAlert({ line: below, retros: [], state: { active: true, firstTriggered: T, lastSent: T }, today: shift(T, 1) });
assert.equal(d.action, 'alert'); assert.equal(d.streak, 2);
// draft does not resolve
d = decideAlert({ line: below, retros: [{ date: shift(T, 1), completed: false }], state: { active: true, firstTriggered: T, lastSent: T }, today: shift(T, 2) });
assert.equal(d.action, 'alert');
// completed retro resolves, then cooldown
d = decideAlert({ line: below, retros: [{ date: shift(T, 1), completed: true }], state: { active: true, firstTriggered: T }, today: shift(T, 2) });
assert.equal(d.action, 'resolved'); assert.equal(d.state.active, false);
d = decideAlert({ line: below, retros: [{ date: shift(T, 1), completed: true }], state: {}, today: shift(T, 10) });
assert.equal(d.action, 'cooldown');
// recovered line ends the round
d = decideAlert({ line: { status: 'ok' }, retros: [], state: { active: true, firstTriggered: T }, today: shift(T, 1) });
assert.equal(d.action, 'none'); assert.equal(d.state.active, false);
// listRetros completed detection: 在 os.tmpdir() 下建两个文件（一个含 PLACEHOLDER）断言 completed
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:retro` → Expected: FAIL（`Cannot find module './retro-core.mjs'`）

- [ ] **Step 3: 实现 `tools/retro-core.mjs`**

`decideAlert` 判定顺序（测试决定不了的部分）：
1. `last = lastCompleted(retros)`；若 `state.active && last && last >= state.firstTriggered` → `resolved`，`state = { active: false }`
2. 若 `last && daysBetween(last, today) < COOLDOWN_DAYS` → `cooldown`，`state = { active: false }`
3. 若 `line.status !== 'below'` → `none`，`state = { active: false }`
4. 否则：`firstTriggered = state.active ? state.firstTriggered : today`；`streak = daysBetween(firstTriggered, today) + 1`；`state.lastSent === today` → `already-sent`，否则 `alert`；返回的 `state` 保留 `lastSent / messageId`（由发送方在发送成功后改写）

`todayBJ` 用 `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })`，与 `pulse.mjs` 一致。

- [ ] **Step 4: 运行确认通过**

Run: `npm run test:retro` → Expected: 全部 ✓，退出码 0

- [ ] **Step 5: 用真实数据冒烟**

Run: `node -e 'import("./tools/retro-core.mjs").then(async m=>{const {listApplications}=await import("./tools/tracker-backend.mjs");const a=await listApplications();const t=m.todayBJ();console.log(m.retroLine(a,{today:t,...m.readRetroConfig()}));console.log(m.cooldownUntil(m.listRetros()))})'`
Expected: `base` 的 n / pos 与 `data/retro/` 里手工复盘报告的基准批一致；`cooldownUntil` = 最近一份已完成复盘日期 + 14 天

---

### Task 2: 必达提醒（`retro-alert.mjs` + 挂 9:00 + capability）

**Files:**
- Create: `tools/feishu/retro-alert.mjs`
- Modify: `tools/feishu/capabilities.mjs:33`（`KNOWN_CAPABILITIES` 末尾加 `'retro_alert'`）
- Modify: `config/profile.yml`、`config/profile.example.yml`（`feishu.capabilities` 下加 `retro_alert: true`，example 注释：复盘线提醒，独立于 im_card，scope domain: im）
- Modify: `tools/feishu/followup.mjs:133`（CLI 入口最前面调用 `runRetroCheck({ dryRun })`，自身 try/catch，失败只打印不退出）
- Test: `tools/test-retro.mjs`（追加）

**Interfaces:**
- Consumes: Task 1 的 `retroLine / listRetros / readAlertState / writeAlertState / decideAlert / readRetroConfig / todayBJ`
- Produces:
  - `renderAlert(line, streak): string` —— markdown，首行 `## 🟥 复盘线触发（第 {streak} 天）`，含窗口日期、窗口 `pos/n (%)`、基准 `pos/n (%)`、下一步 `npm run retro`，以及「生成草稿不算复盘，填完解读/调整/下次问题三节才解除」
  - `runRetroCheck({ dryRun = false, today = todayBJ(), apps, deps } = {}): Promise<{ action, streak, line, feishu: 'sent'|'skipped'|'failed', urgent: 'sent'|'skipped'|'failed', local: boolean, errors: string[] }>`
  - `deps` 默认实现（可注入）：`sendMessage(body, today) → { messageId }`、`sendUrgent(messageId) → void`、`notifyLocal(title, text) → void`、`appendReminder(line) → void`

- [ ] **Step 1: 追加失败测试**

```js
// urgent fails → local fallback still fires, lastSent recorded (用 tmp 目录隔离 state：runRetroCheck 接受 deps.stateIO = { read, write })
const calls = [];
const deps = {
  sendMessage: () => ({ messageId: 'om_x' }),
  sendUrgent: () => { throw new Error('missing scope im:message.urgent'); },
  notifyLocal: () => calls.push('local'), appendReminder: () => calls.push('rem'),
  stateIO: memStateIO(), feishuOn: true,
};
let r = await runRetroCheck({ today: T, apps: belowApps, deps });
assert.equal(r.feishu, 'sent'); assert.equal(r.urgent, 'failed');
assert.deepEqual(calls, ['local', 'rem']); assert.equal(deps.stateIO.read().lastSent, T);
// same-day rerun sends nothing
r = await runRetroCheck({ today: T, apps: belowApps, deps });
assert.equal(r.action, 'already-sent'); assert.equal(calls.length, 2);
// feishu off → local only
// dryRun → no deps called, state not written
```

（`belowApps`：基准月 10 条里 5 条正面，窗口 10 条里 0 条正面；`deps.feishuOn` 覆盖 `isEnabled('retro_alert')`，`deps.stateIO` 覆盖文件读写 —— 把这两个也列进 `deps` 默认实现）

- [ ] **Step 2: 运行确认失败** — `npm run test:retro` → FAIL（`runRetroCheck` 未定义）

- [ ] **Step 3: 实现 `retro-alert.mjs`**

- `sendMessage`：照抄 `notify.mjs` 的 `send()` 路径 —— `['im', '+messages-send', '--user-id', self_open_id, '--markdown', body, '--idempotency-key', 'career-ops:retro:bot:' + today]`，`runLarkCli(args, { write: true, as: 'bot' })`，没拿到 `message_id` 视为失败
- `sendUrgent`：先跑 `lark-cli schema im.messages.urgent_app` 和 `lark-cli im messages urgent_app --help` 确认调用形式（不要凭记忆），params `{ message_id, user_id_type: 'open_id' }`，data `{ user_id_list: [self_open_id] }`，`as: 'bot'`
- 失败处理：`sendMessage` 或 `sendUrgent` 任一失败 → `notifyLocal` + `appendReminder`，错误文本进 `errors`；错误含 `scope` / `permission` 时在 errors 里追加一句：需要的 scope 用 `lark-cli auth scopes --profile <p>` 查，授权交给用户
- `notifyLocal`：`execFileSync('osascript', ['-e', 'display notification "<text>" with title "career-ops 复盘线" sound name "Glass"'])`，文本里的双引号转义
- `appendReminder`：追加 `- [ ] {today} 🟥 复盘线触发（第 N 天）：窗口 x/n vs 基准 y/m → npm run retro` 到 `data/reminders.md`
- 仅在非 dryRun 且 action 为 `alert` 时写 `lastSent = today`、`messageId`；`resolved / cooldown / none` 时写回 decideAlert 给的 state
- dryRun：打印 `renderAlert` 结果和将要执行的两组 argv，不调用任何 deps

- [ ] **Step 4: 运行确认通过** — `npm run test:retro` → 全部 ✓

- [ ] **Step 5: 真实 dry-run** — `node tools/feishu/followup.mjs --dry-run`
Expected: 先输出一行复盘线检查结果（当前应为 `cooldown`，至 2026-11-30），随后照常输出跟进对账；无报错

- [ ] **Step 6: scope 预检（只读）** — `lark-cli auth scopes --profile <feishu.profile>` 与 `lark-cli auth check --profile <p> --scope "<urgent 所需 scope>"`。缺 → 在最终汇报里告诉用户需要授权，不自行发起

---

### Task 3: 报告草稿（`npm run retro`）

**Files:**
- Create: `tools/retro.mjs`
- Modify: `package.json`（`"retro": "node tools/retro.mjs"`）
- Test: `tools/test-retro.mjs`（追加）

**Interfaces:**
- Consumes: Task 1 全部；`RESTART_DATE` from `tools/feishu/pulse.mjs`；`TRACK_FIT` from `tools/tracker-backend.mjs`
- Produces:
  - `parseReportHeader(reportField: string, root = CAREER_OPS): { tier: 'A'|'B'|'C'|'D'|'未标注', reach: '高'|'中'|'低'|'未标注' }` —— 从 `[n](reports/x.md)` 取路径；`**Tier：**` 取首个 A–D 字母；`**可达性：**` 取首个 高/中/低
  - `gateFor(track: string, tier: string): number` —— primary A/B 3.8、C 4.0；secondary A/B 4.1、C 4.3；bridge A/B 4.1、C `Infinity`；evidence-gated 与 D `Infinity`；`未标注` 按 A/B
  - `direction(app): '数据Agent'|'非数据Agent'|'数据Agent（粗分）'|'非数据Agent（粗分）'` —— notes 含 `数据Agent` → 前者；`date >= '2026-11-16'` → `非数据Agent`；更早的按岗位名+notes 关键词粗分（AI 词 + 数据词同时命中）
  - `buildRetroReport(apps, { today, baselineMonth, trigger: 'auto'|'manual', retros }): string`
  - `writeRetro(content, { today, force, dir = RETRO_DIR }): string`（返回路径；已存在且无 force → throw）

- [ ] **Step 1: 追加失败测试**

```js
// missing report file
assert.deepEqual(parseReportHeader('—'), { tier: '未标注', reach: '未标注' });
assert.deepEqual(parseReportHeader('[1](reports/does-not-exist.md)'), { tier: '未标注', reach: '未标注' });
// header parse: tmp 文件含 '**Tier：** C1（…）' 与 '**可达性：** 高（…）' → { tier: 'C', reach: '高' }
// gate
assert.equal(gateFor('ai-data-bridge', 'C'), Infinity);
assert.equal(gateFor('ai-app', '未标注'), 3.8);
// report skeleton
const md = buildRetroReport(sampleApps, { today: T, baselineMonth: '2026-04', trigger: 'manual', retros: [] });
for (const h of ['## 口径', '## 1. 总量', '## 2. 分维度对比', '## 3. 清单', '## 4. 上次的待验证问题', '## 解读', '## 调整', '## 下次复盘要回答的问题'])
  assert.ok(md.includes(h), h);
assert.ok(md.includes(PLACEHOLDER));          // 草稿必须带标记
assert.ok(/\d+\/\d+ \(\d+%\)/.test(md));      // 比率写成 x/n (%)
// refuse overwrite
const dir = mkdtemp(); writeRetro('a', { today: T, dir });
assert.throws(() => writeRetro('b', { today: T, dir }));
writeRetro('c', { today: T, dir, force: true });
```

- [ ] **Step 2: 运行确认失败** — `npm run test:retro` → FAIL

- [ ] **Step 3: 实现 `tools/retro.mjs`**

报告结构严格按 spec §3.5 的 6 部分。三个批次：基准月（满 14 天）/ 复盘线窗口 / 重启后全部（`appliedAt >= RESTART_DATE` 且满 14 天）。每个维度表：行 = 维度取值，列 = 三个批次，单元格 `pos/n (%)`，n < 5 加 `（样本小）`，n = 0 写 `—`。正面回复编号列表按批次列出 `#num`。清单：结案候选（`Applied`、无 `firstResponseAt`/`firstResponse`、投递 > 14 天）；待投队列（`Evaluated` 且 `score >= gateFor(track, tier)`，按 reach 高>中>低>未标注、再 score 降序，Tier 未标注行尾注明）。「上次的待验证问题」取 `retros` 中最近一份（日期 < today）文件里 `## 下次复盘要回答的问题` 到下一个 `## ` 之间的内容，每条后加 `→ ` 留空；没有则写「无上次报告」。最后三节标题后各写一行 `（{PLACEHOLDER}）`。

CLI：`node tools/retro.mjs [--force] [--stdout]`；触发类型由 `readAlertState().active` 决定 auto/manual；`--stdout` 只打印不落盘；写盘后打印路径和一句「草稿带占位标记，填完三节并删掉标记才算完成复盘」。

- [ ] **Step 4: 运行确认通过** — `npm run test:retro` → 全部 ✓

- [ ] **Step 5: 真实数据核对** — `npm run retro -- --stdout | head -80`
Expected: 基准月列与重启后全部列的正面回复 `x/n` 与 `data/retro/` 里手工复盘报告一致，或差异可由「统计日之后新满 14 天的投递」解释

---

### Task 4: 接入 pulse、日报、Claude 路由

**Files:**
- Modify: `tools/feishu/pulse.mjs`（`buildPulse` 返回值加 `retro: { line, cooldownUntil, alert: readAlertState() }`；`renderPulse` 在「信号」块之后加 `── 复盘线 ──` 段）
- Modify: `tools/feishu/notify.mjs`（`buildDigest` 加 `retro`；`renderDigest` 在 `## career-ops 日报` 标题之后、「投递脉搏」之前，`alert.active` 时插入 `### 🟥 复盘线触发（第 N 天）` + 窗口 vs 基准 + `npm run retro`）
- Modify: `.claude/skills/career-ops/SKILL.md`（`## Mode Routing` 之前加「复盘线检查」段）

**Interfaces:**
- Consumes: Task 1 的 `retroLine / readRetroConfig / listRetros / cooldownUntil / readAlertState / todayBJ`

- [ ] **Step 1: 改 pulse** — 复盘线段四行：窗口日期、`窗口正面回复 pos/n (%)`、`基准 {month} pos/n (%)`、状态（`🟥 触发（第 N 天）` / `⏸ 冷却中至 {date}` / `🟩 正常` / `⚪ 数据不足` / `⚪ 未配置基准月`）。复盘线计算失败不能让 pulse 失败（try/catch，打印一行原因）

- [ ] **Step 2: 验证 pulse** — `npm run pulse | sed -n 1,12p` → 看到复盘线段，状态为 `⏸ 冷却中至 2026-11-30`

- [ ] **Step 3: 改日报** — `npm run feishu:digest -- --dry-run` 无报错；临时把 `.alert-state.json` 写成 `{"active":true,"firstTriggered":"2026-11-16"}` 再跑一次，确认 🟥 段出现在投递脉搏之前；验证后删除该临时文件

- [ ] **Step 4: 改 SKILL.md** —— 加入下面这段（原文写入）：

```markdown
## 复盘线检查（每次调用先做）

先读 `data/retro/.alert-state.json`。`active: true` 时，**无论用户调用的是哪个子命令，先用一句话把复盘提出来**：「复盘线已触发第 N 天（窗口正面回复 x/n，低于基准 y/m），建议先跑 `npm run retro` 生成草稿一起复盘」，然后再做用户要的事。文件不存在或 `active` 不为 true → 跳过。复盘草稿带「待 Claude 与用户填写」标记；和用户一起填完解读 / 调整 / 下次问题三节、删掉标记后才算完成。报告写法见 `data/retro/` 里已有的报告：全部基于 tracker 数据，比率写成 `x/n (%)`，关键结论附编号，猜测标「未验证」。
```

- [ ] **Step 5: 全量回归** — `npm run test:retro && npm run test:filter && npm run verify` → 前两个全 ✓，verify 0 errors
