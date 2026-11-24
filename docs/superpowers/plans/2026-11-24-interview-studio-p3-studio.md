# Interview Studio Phase 3 实现计划（本地 Studio + 文字提词）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（native，同前两阶段）。

**Goal:** 按 spec §8 + §10 + §12 P3：localhost 静态 UI（无 CDN）+ 安全 server + 文字模拟练习（完整/锚点/盲测三模式，hint.revealed 落事件）+ Replay 纠正 + 可选 BYOK hybrid（默认关）。

**Architecture:** `tools/interview/server/`（node:http 零新依赖）serve `apps/interview-studio/` 静态资源 + JSON API（薄封装 core 层）；启动打印随机 token；浏览器带 token 访问。练习直接落 session/events（复用 P1），mock_blind 答题自动进独立掌握度统计。

**Tech Stack:** node:http + 原生 ESM HTML/CSS/JS；零新增 npm 依赖。

**Spec:** §8（页面与验收）、§9.2（检索决策，P3 只做文本）、§10（安全）、§12 P3。

## Global Constraints（P3 增量）

- server 只监听 127.0.0.1；校验 Host 与 Origin（非本机来源 403）；拒绝跨源；随机启动 token（终端打印），API 全部要求 token；无 CORS `*`
- 不信任浏览器传入路径；文件操作全走 core 层 safeJoin
- CSP：`default-src 'self'`；静态资源零 CDN、零内联事件处理器（用 addEventListener）
- 转录/JD/检索内容是非可信数据：渲染时 HTML-escape（textContent / escapeHtml）
- 盲测：回答结束（自评/揭示）前不得返回命中块/候选/答案内容；`hint.revealed` 落事件；该回答不进独立掌握度
- real_record_only 模式永不返回定位结果/锚点/答案
- API Key 不回显、不写日志；Settings 页只显示 provider 配置存在性
- 默认 lexical；embedding/Judge BYOK 失败不阻塞基础操作

## Review Focus

1. 无 token / 错 token 的 API 与静态页访问 → 401/403
2. 伪造 Origin（evil.com）或非本机 Host → 403
3. 静态文件路径穿越（/../../etc/passwd）→ 400/404
4. 盲测模式 API 泄漏：locate 响应在 reveal 前不含 block 内容/候选文本
5. XSS：转录文本含 `<script>` 时页面渲染必须 escape（对 API 返回 JSON 已安全；查前端 escape 函数与 smoke 断言）

---

### Task 1: server 安全骨架 + 静态服务

**Files:** Create `tools/interview/server/server.mjs`（createStudioServer(root, {port, token}) 返回 http server，可注入端口测试）、`tools/interview/server/static.mjs`（路径安全 + MIME）、`apps/interview-studio/index.html`（占位壳）、Modify `tools/interview/cli.mjs`（`studio` 子命令：启动 + 终端打印 URL/token）、npm script `interview:studio`、Test `tools/interview/test/server-security.test.mjs`

- [ ] RED→GREEN：随机端口起 server → 无 token 401；错 token 401；伪造 Origin 403；Host 非 127.0.0.1 403；静态 `/../../etc/passwd` 400；正确 token 拿到 index.html；CSP 头存在
- [ ] commit

### Task 2: 知识库/统计/包 API

**Files:** Modify `server.mjs`（JSON API 路由）、Test `server-api.test.mjs`

**Interfaces:** `GET /api/blocks`（列表含 front matter + 正文）、`GET /api/blocks/:id`、`POST /api/blocks/:id`（编辑正文/front matter，走 writeBlock 校验）、`GET /api/search?q=`（decide 结果：hit 带 block 内容；candidates 只带 blockId+score）、`GET /api/stats`、`GET /api/bootstrap`、`GET /api/packs` + `GET /api/packs/:id`、`GET /api/seeds`

- [ ] RED→GREEN：各端点正确 JSON；编辑块走 schema 校验（坏 front matter 400）；search 在 candidates 时不返回块正文
- [ ] commit

### Task 3: Practice API（三模式 + 揭示事件 + 自评）

**Files:** Create `tools/interview/server/practice.mjs`、Test `server-practice.test.mjs`

**Interfaces:**
- `POST /api/practice/start` {mode: mock_full|mock_anchor|mock_blind, track?} → session（复用 createSession，events: session.created）
- `POST /api/practice/:sid/question` {text} → {decision: hit|candidates|unknown, block?: 仅 full/anchor 且 hit 时}；盲测/未揭示前：响应不含 block 正文与候选文本；锚点模式只回 anchors
- `POST /api/practice/:sid/reveal` {question_ref} → hint.revealed 事件 + 此时返回块内容（盲测在此刻才给）
- `POST /api/practice/:sid/rate` {question_ref, score 0-4, revealed: bool} → rating.self 事件；revealed=true 的评分带 assisted 标记
- `POST /api/practice/:sid/finish` → session.finished

- [ ] RED→GREEN：盲测 question 响应无内容泄漏；reveal 后有；hint.revealed/rating.self 落事件可查；full 模式 hit 直接带块
- [ ] commit

### Task 4: Replay API（纠正 + 对齐确认）

**Files:** Modify server + Test

- `GET /api/sessions` 列表（含 mode/round/application/retrospective）
- `GET /api/sessions/:id`（utterances/questions/review）
- `POST /api/sessions/:id/correct` {utterance_id, role} → segment.corrected 事件 + 更新 utterances.json 的 role（原 raw 不动）
- `POST /api/sessions/:id/confirm-alignment` {question_id, status, matched_block_ids} → alignment.confirmed 事件 + questions.json 更新（人工纠正入口）

- [ ] RED→GREEN：纠正落事件且 raw_text 不变；确认对齐后 stats 可用
- [ ] commit

### Task 5: UI（七页面，vanilla）

**Files:** `apps/interview-studio/`：index.html（壳 + hash 路由）、app.js（页面渲染 + fetch 封装 + escapeHtml）、style.css（紫 #7C5CFC 仅品牌强调、prefers-color-scheme 深浅）
页面：建库/知识库/准备工作台/Heatmap/Practice/Replay/Settings（doctor + provider 存在性，Key 不回显）

- [ ] RED→GREEN（smoke）：全部静态文件存在；`node --check app.js` 通过；grep 无 CDN/外链 URL；app.js 含 escapeHtml 且 innerHTML 注入点均走 escape
- [ ] commit

### Task 6: BYOK embedding + hybrid（默认关，可选）

**Files:** Create `providers/embedding.mjs`（OpenAI-compatible 适配 + 缓存键 provider/model/dim/content_hash）、Modify retrieval（hybrid RRF 可选）、Test（本地 stub embedding server，mock 向量）

- [ ] RED→GREEN：默认 lexical 不变；配 embedding 后缓存命中（同文本二次调用不重复请求）；provider 失败 → 降级 lexical + warning
- [ ] commit

### Task 7: 文档 + 回归 + 终审

- [ ] docs/INTERVIEW-STUDIO.md（启动方式/安全模型/页面说明）、modes 更新、npm script、全量回归、commit
- [ ] 外部 reviewer 终审（安全面）
