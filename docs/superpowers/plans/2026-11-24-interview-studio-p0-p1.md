# Interview Studio Phase 0 + Phase 1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/interview-studio/spec-v0.2.md`（v0.2 规格）落地 Phase 0（仓库基线 + CLI 骨架）与 Phase 1（Interview Brain 冷启动 + 离线逐字稿复盘 + 统计 + patch），共两条可验收的垂直切片：A. 仅 CV → 种子 → 深挖 → 审批 → 首批练习题单 → JD 增量信号；B. 逐字稿导入 → 对齐 → 复盘 → 热度统计 → patch。

**Architecture:** 全部新代码在 `tools/interview/`（Node ESM .mjs），CLI 入口 `npm run interview:kb`；用户数据只进 gitignored 的 `interview-prep/`；确定性操作（校验、存储、检索、统计）由 CLI 承担，语义任务（问题切分、对齐、判分草稿）通过「导出任务 JSON → agent mode 回填 → CLI 校验提交」离线完成，不要求 API Key。P1 不实现 Pack Compiler（P2）、本地 UI（P3）、ASR（P4）。

**Tech Stack:** Node 22（仓库现状 v22.23.0）、ESM .mjs、`yaml` ^2（安全 YAML）、`ajv` ^8（JSON Schema 校验）、`node:test` + `node --test` 跑测试。复用现有 `tools/cv-facts.mjs`（账本读取）、`marked`（不必须）。

**Spec:** `docs/interview-studio/spec-v0.2.md`（Task 1 从仓库根移入；实现时与计划一起读）

## Global Constraints（摘自规格，逐条硬约束）

- Node ESM `.mjs`；无 native 模块；默认离线，`doctor` 不联网（`--probe` 才允许，P1 不实现 probe）。
- 新依赖只允许 `yaml`、`ajv`，锁版本；禁止 Python/Docker/GPU/云服务硬依赖。
- 存储：Markdown + YAML front matter + JSON/JSONL；重要写入用临时文件 + rename；JSONL 单写者。
- 默认 `interview.enabled: false`、`provider: none`；未启用时旧流程零变化；禁止把默认改云端。
- 所有 schema `schema_version: 1`；未知字段拒绝或迁移，不静默丢失；重复 YAML key 报错。
- `block_id` 正则：`/^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9._-]{0,127}$/`；`revision` 正整数。
- 路径安全：所有文件操作限制在已解析的 root 内；拒绝 `..`、绝对路径、越界 symlink。
- CLI：`--json` 支持；exit 0 成功 / 2 校验失败 / 3 用法错误 / 4 目标不存在 / 1 未预期；错误提示中文。
- 信号三分类隔离：`predicted`（JD/Block F/模板/CV 推导）、`observed`（真实面试对齐）、`practice`（模拟）；无真实样本时 frequency/mastery 为 `null`，不得用预测填补。
- Rubric 权重固定 30/25/20/15/10；每维 0–4 + na/unknown；重大事实冲突 → `needs_review` 硬闸门，禁止标掌握。
- 优先级公式：`0.25*frequency + 0.35*(1-mastery) + 0.25*relevance + 0.10*risk + 0.05*forgetting`，缺失维度按可用权重重新归一。
- `dig` 每轮 ≤5 题；「跳过/记不清/没做过」保留状态不编造。
- 测试全部用虚构 fixture，禁止读写真实 `interview-prep/`（现有 story-bank.md 只读不写）与真实 Tracker；CLI 用 `--root`/`--cv` 注入临时目录。
- 不修改 Tracker 状态机、不自动调用 `addRound()`、不改 cv.md canonical 规则、不碰用户未提交的 `modes/contact.md`。
- commit 粒度：每 task 一个 commit；Phase 0、slice A、slice B 自然形成独立边界；commit 只 add 本 task 文件。

## Review Focus（规格隐含、单靠任务测试最容易漏的五类输入）

1. **路径越界**：`--root /etc`、`--file ../../cv.md`、root 内 symlink 指向外部 → 必须拒绝且中文报错（Task 3 测试 `rejects traversal and symlink escape`）。
2. **坏 front matter**：重复 YAML key、未知字段、重复 rubric id、非法 block_id → 拒绝进库，绝不静默丢字段（Task 4/5 测试）。
3. **信号泄漏**：只有 predicted/practice 信号时，真实 frequency/mastery 必须是 `null` 且页面/JSON 明示「暂无真实面试样本」（Task 18 测试）。
4. **重复导入**：同 hash 逐字稿、同 KB 文件、同 report 扫两次 → 不重复计数、不重复建块、提示复用（Task 11/13/18 测试）。
5. **写入中断**：JSONL 尾部半行、进程崩溃 → 丢弃尾部不完整行并记 recovery 事件，历史有效行不丢（Task 14 测试）。

---

### Task 1: 基线 ADR + 规格归档

**Files:**
- Create: `docs/interview-studio/decisions.md`
- Move: `career-ops-china-interview-studio-spec-v0.2.md` → `docs/interview-studio/spec-v0.2.md`

- [ ] **Step 1:** `mkdir -p docs/interview-studio && mv career-ops-china-interview-studio-spec-v0.2.md docs/interview-studio/spec-v0.2.md`
- [ ] **Step 2:** 写 `decisions.md` ADR-0001，内容 = 本次基线核对结果（执行时逐条复核）：
  - HEAD `1cb80d3`；Node v22.23.0；lockfile 存在；测试模式 = 独立 `tools/test-*.mjs` + npm script（无集中 runner）。
  - `git ls-files interview-prep cv-evolve` 为空 ✓；`interview-prep/*` 已 gitignored ✓（`.gitignore:96`）。
  - 接口面：`tools/feishu/interviews.mjs` 导出 `ROUNDS/ensureTable/listRounds/addRound`（本模块绝不调用 `addRound`）；`tools/cv-facts.mjs` 导出 `readLedger/parseLedger/extractClaims`；`tools/cv-version.mjs` 子命令 `init/status/commit/log/diff/affected`。
  - 决策：onboarding 邀请落在 SKILL.md + CLAUDE.md onboarding Step 6 各加一行（Task 12，diff 见该 task）；report 落盘登记采用「mode 末尾登记指令 + `signals reconcile --scan-reports` 显式补扫」（规格 §4.2.1 允许，需 ADR）；`--root/--cv` 测试注入旗标仅服务测试/demo，默认值不变。
- [ ] **Step 3:** Commit: `git add docs/interview-studio/ && git commit -m "docs(interview): archive spec v0.2 + baseline ADR"`

### Task 2: 依赖 + 配置样例 + 安全 YAML

**Files:**
- Modify: `package.json`（dependencies 加 `yaml`、`ajv`）
- Modify: `config/profile.example.yml`（末尾追加 §10 的 `interview:` 段，逐字照抄）
- Create: `tools/interview/core/yaml.mjs`
- Test: `tools/interview/test/yaml.test.mjs`

**Interfaces (Produces):**
- `loadYamlSafe(text: string): object` — 重复 key / 未知 tag / 解析错误抛 `YamlSafeError`（中文 message）。
- `splitFrontMatter(mdText: string): { frontMatter: object, body: string }` — `---` 围栏 front matter + markdown body；无围栏抛错。

- [ ] **Step 1: 失败测试**（`yaml.test.mjs`，node:test + assert）
  - 重复 key：`loadYamlSafe('a: 1\na: 2')` throws 且 message 含「重复」。
  - 未知 tag：`loadYamlSafe('a: !!python/object x')` throws。
  - 正常对象 + front matter 切分（含正文中出现 `---` 水平线不影响已切出的 frontMatter）。
- [ ] **Step 2:** `npm run test:interview` 先建 npm script（`"test:interview": "node --test tools/interview/test/"`），跑一次确认 FAIL（文件/模块不存在）。
- [ ] **Step 3:** `npm install yaml@^2 ajv@^8`（锁进 package-lock）；实现 `core/yaml.mjs`（`yaml` 包 v2 默认拒绝重复 key 与未知 tag，包一层错误中文化）。
- [ ] **Step 4:** 测试 PASS。
- [ ] **Step 5:** `config/profile.example.yml` 末尾追加规格 §10 的 `interview:` YAML（从 `enabled: false` 到 `judge.timeout_ms`，逐字）；Commit `feat(interview): deps + safe yaml + profile example`。

### Task 3: 安全存储层

**Files:**
- Create: `tools/interview/core/storage.mjs`
- Test: `tools/interview/test/storage.test.mjs`

**Interfaces (Produces):**
- `resolveRoot(rootArg?: string): { root, paths }` — 默认 `<repo>/interview-prep`；`paths` 为 §4 布局的常量表（blocks/bootstrap/signals/drafts/imports/sessions/reviews/patches/versions/cache）。
- `safeJoin(root, ...segs): string` — 结果解析后必须仍在 root 内，否则抛 `PathEscapeError`（中文）；拒绝绝对路径段与 `..`。
- `atomicWriteJson(file, obj)` / `atomicWriteText(file, text)` — tmp + `renameSync`。
- `appendJsonl(file, obj)` — 单行 JSON + `\n`。
- `readJsonlSafe(file): { rows, recovered }` — 尾部不完整行丢弃并返回 `recovered: 1`。
- `withLock(file, fn)` — 同目录 `<file>.lock` 排他（`wx` 创建，进程退出清理；拿不到锁抛中文错「另一个进程正在写」）。

- [ ] **Step 1: 失败测试** — 核心断言：
  - `safeJoin(root, '../x')`、`safeJoin(root, '/etc/passwd')` throws `PathEscapeError`。
  - symlink 越界：tmp 内建 `link -> /etc/hosts`，`safeJoin(root, 'link')` throws。
  - `atomicWriteJson` 后内容可 JSON.parse；`appendJsonl` 两次得两行。
  - `readJsonlSafe`：3 完整行 + 尾部 `'{"trunc'` → `rows.length===3, recovered===1`。
  - `withLock` 并发第二次进入 throws；释放后可再入。
- [ ] **Step 2:** FAIL → **Step 3:** 实现（`fs.rmSync`/`renameSync`/`realpathSync`/`lstatSync`；全部同步 API，CLI 单进程无需异步）。
- [ ] **Step 4:** PASS → **Step 5:** Commit `feat(interview): safe storage layer`。

### Task 4: Schema 校验注册表（Ajv）

**Files:**
- Create: `tools/interview/core/validation.mjs`
- Test: `tools/interview/test/validation.test.mjs`

**Interfaces (Produces):**
- `registerSchema(name, schemaObject)`；`validate(name, data): { ok, errors }` — errors 为中文可读数组（Ajv 错误映射：路径 + keyword + message）。
- `assertValid(name, data)` — 失败抛 `ValidationError`（exit 2 用）。

- [ ] **Step 1: 失败测试** — 未注册 schema 报中文错；校验失败 errors 含字段路径；`additionalProperties: false` 的 schema 传未知字段被拒。
- [ ] **Step 2:** FAIL → **Step 3:** 实现（Ajv 2020-12，`allErrors: true`，加载 `tools/interview/schemas/*.schema.json` 全量注册，schema 文件名 = name）。
- [ ] **Step 4:** PASS → **Step 5:** Commit `feat(interview): ajv validation registry`。

### Task 5: Answer Block schema + fixture + validate 命令

**Files:**
- Create: `tools/interview/schemas/answer-block.schema.json`（§4.1 全字段：schema_version/block_id/revision/kind/project/status/tracks/rounds/questions/anchors/fact_refs/claim_kind/related/criticality/pinned/source_refs/rubric；枚举与上限照规格：kind `qa|story|flashcard|intro|checklist`，status `draft|active|archived|superseded`，claim_kind `experience|design|knowledge`，criticality `high|normal|low`；`questions` 1–20 项；rubric.required/forbidden id 唯一；`additionalProperties: false`）
- Create: `tools/interview/test/fixtures/block-demo.md`（§4.1 示例块逐字，`demo.query-permission`，虚构内容）
- Modify: `tools/interview/cli.mjs`（骨架：argv 解析、`--json`、exit codes、`validate --file` 子命令）
- Test: `tools/interview/test/blocks-validate.test.mjs`

- [ ] **Step 1: 失败测试** — fixture 块 `validate` 通过（exit 0）；注入未知字段 → exit 2 + 中文错误含字段名；`block_id: 'Bad ID'` → exit 2；rubric 两个 `id: p1` → exit 2；`claim_kind: experience` 但 `fact_refs: []` → exit 2（experience 必须有引用；knowledge 可空）。
- [ ] **Step 2:** FAIL → **Step 3:** 实现 schema + cli 骨架（`validate` = splitFrontMatter → loadYamlSafe → assertValid；无 `--root` 依赖）。
- [ ] **Step 4:** PASS → **Step 5:** Commit `feat(interview): answer block schema + validate`。

### Task 6: init / doctor 命令（Phase 0 收口）

**Files:**
- Modify: `tools/interview/cli.mjs`
- Test: `tools/interview/test/cli-init.test.mjs`

- [ ] **Step 1: 失败测试**（均用 `--root <tmp>`，绝不碰真实 interview-prep）：
  - `init` 两次：目录与 `.gitkeep` 幂等，已存在的 `knowledge/blocks/` 内容不被覆盖（预放一个文件断言仍在）。
  - `init` 不写 root 外任何文件。
  - `doctor` 在健康 tmp root 上 exit 0；root 不可写（chmod 500）时 exit 2 且 message 中文；输出 JSON 含 `node/yaml/ajv/writable/config` 五项检查。
  - 缺 `config/profile.yml` 的 `interview` 段不算失败（默认 disabled），doctor 报 `config: 'default (disabled)'`。
- [ ] **Step 2:** FAIL → **Step 3:** 实现。
- [ ] **Step 4:** PASS。**Phase 0 验收复跑**：`npm run test:interview` 全绿 + `npm run verify`（旧流程）不受影响 + `npm run sync-check` 通过。
- [ ] **Step 5:** Commit `feat(interview): init/doctor cli (phase 0 complete)`。

### Task 7: Bootstrap 状态机 + 种子生成（切片 A 核心）

**Files:**
- Create: `tools/interview/core/bootstrap.mjs`、`tools/interview/core/seeds.mjs`
- Create: `tools/interview/schemas/bootstrap-state.schema.json`（§4.2.1 `bootstrap.json` 字段）、`tools/interview/schemas/seed.schema.json`（§4.2.1 `question_seed` 全字段，`origin_kind: template|cv|jd|report_f|story_import|transcript|user`，`status: queued|needs_input|draft_ready|linked|dismissed`）
- Create: `templates/interview/seed-templates.yml`（通用模板：`intro.self`；`project.{p}.story|contribution|decision|result|boundary`，带 questions/rounds/priority）
- Modify: `tools/interview/cli.mjs`（`bootstrap --from cv [--cv <path>]`、`bootstrap status`、`seed list`）
- Test: `tools/interview/test/bootstrap-seeds.test.mjs`
- Fixture: `tools/interview/test/fixtures/cv-fixture.md`（虚构候选人「李示例」，两段项目经历 + 技能段，标题结构与真实 cv.md 同构）

**Interfaces (Produces):**
- `parseCvProjects(cvText): [{ slug, title }]` — 「项目经历」段下 `### ` 标题 → slug（拼音不转，取标题安全 slug：非 `[a-z0-9-]` 字符转 `-`）。
- `generateSeeds(cvText, { trackIds }): seed[]` — 首批 ≤10：`intro.self` 优先，其后按 CV 项目顺序 × 意图优先级（story→contribution→decision→result→boundary）；`origin_kind: template`，`status: queued`，`seed_id` 确定性（`sha256(intent_key)[:12]`）。
- `loadBootstrap(root)` / `saveBootstrap(root, state)` — 状态机 `not_started|in_progress|ready|paused`；`ready` = ≥1 个已批准块；`dismissed` 持久，重复邀请不再弹。

- [ ] **Step 1: 失败测试**：
  - fixture CV → seeds 含 `intro.self` + 项目种子，总数 ≤10 且 ≥5；同 CV 再跑一次 `bootstrap --from cv` → 种子集不变（幂等，不重复建）。
  - `seed_id` 同输入稳定；`seed.schema.json` 校验全过；`intent_key` 全小写安全 slug。
  - `bootstrap status` 在 init 后未 bootstrap 时报 `not_started`；手动把 state 改 `paused` 再 `bootstrap --from cv` → 恢复且不覆盖已有 seeds（`seed_ids` 只增）。
  - `--cv` 缺省时读 `<repo>/cv.md`，不存在则 exit 4 + 中文提示「先完成 CV setup 或用 --cv 指定」。
- [ ] **Step 2:** FAIL → **Step 3:** 实现（CV 解析用标题正则即可，P1 不需要 marked AST）。
- [ ] **Step 4:** PASS → **Step 5:** Commit `feat(interview): bootstrap + seed generation`。

### Task 8: Dig 深挖（≤5 题/轮）

**Files:**
- Create: `tools/interview/core/dig.mjs`
- Create: `tools/interview/schemas/dig-result.schema.json`（`[{seed_id, status: answered|skipped|unclear|not_done, raw_answer?: string}]`）
- Modify: `tools/interview/cli.mjs`（`dig prepare` 输出 ≤5 题的 markdown 问卷 + `--json`；`dig ingest --file <result.json>`）
- Test: `tools/interview/test/dig.test.mjs`

- [ ] **Step 1: 失败测试**：
  - `dig prepare` 从 queued seeds 取前 5（intro 优先，随后项目 story/contribution/result）；第 6 题不出现。
  - ingest answered → seed `status: draft_ready` + 原话存 `knowledge/drafts/<seed_id>.md`（原文原样，不重写）；unclear → `needs_input`；not_done → `dismissed`（附 `无此经历` note）；skipped → 留在 `queued`。
  - 已 `draft_ready/dismissed` 的 seed 下一轮 `dig prepare` 不再出现。
  - result 文件引用不存在的 seed_id → exit 2。
- [ ] **Step 2:** FAIL → **Step 3:** 实现 → **Step 4:** PASS → **Step 5:** Commit `feat(interview): dig rounds`。

### Task 9: 草稿导出 + 审批激活（blocks.mjs 完整版）

**Files:**
- Create: `tools/interview/core/blocks.mjs`、`tools/interview/core/drafts.mjs`
- Create: `tools/interview/schemas/answer-draft.schema.json`（`[{seed_id, block_id, claim_kind, markdown, anchors[], questions[], rubric, fact_refs[]}]`）
- Modify: `tools/interview/cli.mjs`（`drafts export`（为每个 draft_ready seed 生成 agent 任务 JSON）+ `approve --file <drafts.json>`）
- Test: `tools/interview/test/drafts-approve.test.mjs`

**Interfaces (Produces):**
- `writeBlock(root, frontMatter, body)` — 写 `knowledge/blocks/<block_id>.md`（front matter + body），revision 取已有 max+1，写前 hash 校验（并发修改拒绝）；每次写后更新 `knowledge/versions/manifest.json`（block_id → revision、content sha256、原因、时间）。
- `readBlocks(root): [{ frontMatter, body, file }]` — 只读 `status: active`（`--all` 含 draft/archived）。
- `draftsExport(root)` — 任务 JSON 含 seed 原话、seed.fact_refs、输出 schema 说明与审批门槛提示。
- `approveDrafts(root, file)` — 逐条校验 schema → 写 block（revision 1，`status: active`）→ seed `status: linked` + `answer_block_id` 回填 → bootstrap.state 升 `ready`。

- [ ] **Step 1: 失败测试**：
  - approve 前块文件不存在、`readBlocks` 为空；approve 后块存在、`status: active`、bootstrap `ready`。
  - `claim_kind: experience` 且 fact_refs 引用不存在的 fact id → exit 2（P1 规则：fact_refs 里的 id 必须存在于 seed.fact_refs 或 `knowledge/tech-facts.yml`，否则拒绝——未确认事实不得进 active 块）。
  - 重复 approve 同一文件 → 幂等：block revision 不变、不产生第二个块文件（按 seed 已 `linked` 短路 + 提示）。
  - 同 block_id 再 approve 新版本（seed 置回 draft_ready 模拟）→ revision 2，manifest 记录两个 hash。
- [ ] **Step 2:** FAIL → **Step 3:** 实现 → **Step 4:** PASS → **Step 5:** Commit `feat(interview): drafts export + approve to blocks`。

### Task 10: 练习题单输出

**Files:**
- Modify: `tools/interview/cli.mjs`（`practice [--track <t>]`）
- Test: `tools/interview/test/practice.test.mjs`

- [ ] **Step 1: 失败测试**：空库时 exit 0 + 中文「知识库为空，先 bootstrap/dig/approve」；approve 后 `practice` 输出 markdown 含每个 active 块的 questions、anchors、30秒版标题；`--track ai-app` 过滤只留 `tracks` 含该值的块；draft 块不出现在题单。
- [ ] **Step 2:** FAIL → **Step 3:** 实现（纯模板渲染）→ **Step 4:** PASS → **Step 5:** Commit `feat(interview): practice list`。

### Task 11: 信号引擎 + report 补扫

**Files:**
- Create: `tools/interview/core/signals.mjs`
- Create: `tools/interview/schemas/signal.schema.json`（§4.2.1 `signal` 全字段）
- Modify: `tools/interview/cli.mjs`（`signals reconcile [--scan-reports] [--check-cv]`）
- Test: `tools/interview/test/signals.test.mjs`

**Interfaces (Produces):**
- `appendSignal(root, signal)` — `signal_id` = sha256(`source_kind|source_ref|intent_key`)[:16]；已存在同 id → 跳过返回 `{deduped: true}`；`appendJsonl` + `withLock`（单写者）。
- `scanReports(root, reportsDir)` — 扫 `reports/*.md` 头部（公司/岗位/Track/Score 行）+ Block F 存在性，每个未登记 report 追加一条 `kind: predicted, source_kind: report_block_f` 信号。
- `checkCvFacts(root)` — CV evolve 显式增量核验：若 `cv-evolve/ledger.yml` 存在，读 `readLedger()`（复用 `tools/cv-facts.mjs`），对每个 active 块的 `fact_refs` 中 `cv:<id>` 检查该 id 仍在账本且 status 未变；变化 → 写 `knowledge/review-flags.jsonl`（block_id + 变化类型），不改块、不改账本。story-sync 兼容核验在 Task 12 的 mode 文件中约定（interview 模块只读 story-bank.md，绝不写）。

- [ ] **Step 1: 失败测试**：
  - 同一 report 扫两次 → 第二次全 `deduped: true`，signals.jsonl 行数不变。
  - `--scan-reports` 指向含 2 个 fixture report 的临时目录（**不是**真实 reports/）→ 2 条 predicted 信号，带 `source_ref` 文件名。
  - `interview.enabled: false`（显式配置）时 reconcile no-op 且 exit 0。
  - 手写重复 `signal_id` 不同内容 → 仍被 dedup（id 幂等键语义）。
  - `--check-cv`：fixture 库中某块 fact_refs 含 `cv:fake.old_id`、临时 ledger fixture 里该 id 缺失 → `review-flags.jsonl` 出现一条记录；ledger 未初始化（无文件）→ no-op exit 0。
- [ ] **Step 2:** FAIL → **Step 3:** 实现 → **Step 4:** PASS → **Step 5:** Commit `feat(interview): signals + report reconcile`。

### Task 12: interview-prep mode 文档 + 路由 + onboarding 邀请（切片 A 收口）

**Files:**
- Create: `modes/interview-prep.md`（§11 契约：schema、允许的事实引用（`cv:<ledger-id>` / locator pending / `tech:<id>`）、输出限制、原话证据规则、unknown 分支、用户批准门槛；workflow = Task 7–11 的 agent 侧编排）
- Modify: `.claude/skills/career-ops/SKILL.md`（argument-hint 加 `interview-prep`；Mode Routing 表加行：`interview-prep` → `modes/interview-prep.md`；Standalone modes 列表加 `interview-prep`）
- Modify: `docs/MODES.md`（模式表加 `interview-prep` 一行）
- Modify: `CLAUDE.md`（onboarding Step 6 末尾追加一行：「（可选，可跳过）想建面试知识库可以跑 `/career-ops interview-prep init`，没有逐字稿也能从 CV 冷启动」——一行，不改其他内容）
- Test: 无代码测试；验收 = `grep` 四处路由/邀请齐全 + `npm run verify` 不受影响。

- [ ] **Step 1:** 写文件与三处路由修改。
- [ ] **Step 2:** 复跑 `npm run test:interview`（仍全绿）+ `npm run sync-check`。
- [ ] **Step 3:** Commit `feat(interview): interview-prep mode + routing (slice A complete)`。

### Task 13: 知识块导入（逐字稿/笔记 → 候选 → 审批）

**Files:**
- Create: `tools/interview/core/import.mjs`
- Create: `tools/interview/schemas/import-candidates.schema.json`（`[{source_locator, candidate: <answer-block front matter + body 前体>, questions[], anchors[], fact_refs[], claim_kind}]`）
- Modify: `tools/interview/cli.mjs`（`import --file <md>` 保存原件 + 产出 agent 任务；`import apply --file <candidates.json>`）
- Test: `tools/interview/test/import.test.mjs`
- Fixture: `tools/interview/test/fixtures/notes-fixture.md`（虚构 Q/A 笔记，含一个与 cv-fixture 项目重叠的问题）

- [ ] **Step 1: 失败测试**：
  - `import --file` → 原件存 `imports/<sha256前12>-<basename>` + `imports/<hash>.meta.json`（hash/时间/来源）。
  - 同文件再导 → 提示复用（`{reused: true}`），imports/ 不出第二个副本。
  - `import apply` 用 fixture candidates → 候选写入 `knowledge/drafts/import-*.md`（`status: draft`），不出现在 `practice`；审批走 Task 9 的 `approve`（import candidates 与 drafts 共用审批路径）→ 激活后 `practice` 可见。
  - 与已有 active 块同 `intent`（问题语义由 locator+questions 哈希判重，P1 不做语义模型：同 questions 归一化文本哈希相等即重复）→ 候选标 `duplicate_of: <block_id>`，默认不建新块。
- [ ] **Step 2:** FAIL → **Step 3:** 实现 → **Step 4:** PASS → **Step 5:** Commit `feat(interview): knowledge import`。

### Task 14: 逐字稿标准化 + Session/事件日志

**Files:**
- Create: `tools/interview/review/normalize.mjs`、`tools/interview/core/sessions.mjs`
- Create: `tools/interview/schemas/session.schema.json`、`event.schema.json`、`utterance.schema.json`
- Modify: `tools/interview/cli.mjs`（`transcript import --file <md|txt|srt|json> [--application N] [--round R] [--root]`）
- Test: `tools/interview/test/normalize-sessions.test.mjs`
- Fixture: `tools/interview/test/fixtures/transcript-fixture.md` + `.srt`（虚构技术面试：面试官 3 问 + 候选人 3 答 + 1 段寒暄，无说话人标签）

**Interfaces (Produces):**
- `normalizeTranscript(text, fmt): [{ id, role: 'interviewer'|'candidate'|'unknown', speaker_id?, start_ms?, end_ms?, raw_text, source_span }]` — SRT 用时间戳；MD/TXT 无时间戳 → null，不编造；**角色不得按问号推断**，无标签一律 `unknown`。
- `createSession(root, { applicationNum?, round?, mode, source }): session` — session_id uuid，`kb_revision` = 当前 manifest hash，写 `sessions/<id>/session.json` + 空 `events.jsonl`（`session.created` 事件）。
- `appendEvent(root, sessionId, event)` — `seq` 单调（读尾行 + 1），`withLock`；`session_id` 不存在 → exit 4。
- `recoverEvents(root, sessionId)` — 尾部不完整行丢弃 + 追加 `recovery` 记录。

- [ ] **Step 1: 失败测试**：
  - MD fixture → utterances 数 > 0，全部 `role: unknown`（寒暄段也在，不标 non_question——那是 segmentation 的事）；SRT fixture → `start_ms/end_ms` 正确解析。
  - 同一文件对同一 `(application, round)` 再导 → 返回已有 session_id + `{reused: true}`（hash + num + round 匹配）。
  - `appendEvent` 三条 → seq 1,2,3；人为截断 events.jsonl 尾行 → `recoverEvents` 后 rows 完整 + recovered 标记。
  - `transcript import --application 999999` 不校验 tracker 存在性（P1 允许 application_num 可空/未校验，规格 §4.3），但 `--round` 不在 `ROUNDS` 白名单时 exit 2（复用 `tools/feishu/interviews.mjs` 的 `ROUNDS` 导入）。
- [ ] **Step 2:** FAIL → **Step 3:** 实现 → **Step 4:** PASS → **Step 5:** Commit `feat(interview): transcript normalize + session events`。

### Task 15: 本地词法检索

**Files:**
- Create: `tools/interview/retrieval/tokenizer.mjs`、`tools/interview/retrieval/bm25.mjs`、`tools/interview/retrieval/rank.mjs`
- Test: `tools/interview/test/retrieval.test.mjs`

**Interfaces (Produces):**
- `tokenize(text): string[]` — NFKC 归一 → 中文按字 bigram + 英文/数字 token（`/[a-z0-9]+/i`）→ 小写。
- `buildIndex(blocks): index` — 语料 = 每块的 questions + anchors + project + 正文首段；aliases 从 questions 归一文本派生。
- `search(index, query, { topK = 5 }): [{ blockId, score } ]` — BM25（k1=1.2, b=0.75）。
- `decide(query, results, { autoThreshold }): 'hit'|'candidates'|'unknown'` — 精确归一文本等于某块 question 且唯一 → `hit`（自动确认）；否则 score 差距不足或 topK 低分 → `candidates`；无结果 → `unknown`。阈值默认保守（P1 全部走 candidates，`hit` 仅限唯一精确别名）。

- [ ] **Step 1: 失败测试**：
  - `tokenize('查询权限 LangGraph')` 含 bigram「查询/询权/权限」与 token `langgraph`。
  - fixture 块问题「你如何限制查询权限？」查询「怎么限制查询权限」→ top1 = demo.query-permission。
  - 完全无关查询「今天天气怎么样」→ `unknown`（不返回候选）。
  - 同义句（与某 question NFKC 归一后相等）→ `hit`；两块含完全相同 question → `candidates`（不唯一不自动跳）。
- [ ] **Step 2:** FAIL → **Step 3:** 实现 → **Step 4:** PASS → **Step 5:** Commit `feat(interview): lexical retrieval`。

### Task 16: 问题切分与对齐（agent 任务导出/回填）

**Files:**
- Create: `tools/interview/review/segment.mjs`、`tools/interview/review/align.mjs`
- Create: `tools/interview/schemas/segmentation-result.schema.json`（`[{question_id, utterance_refs[], kind: question|followup|compound|non_question, notes?}]`）、`alignment-result.schema.json`（`[{question_id, status: matched|ambiguous|unmatched|non_question|pending, matched_block_ids[], evidence_refs[], reasoning_summary?}]`）
- Modify: `tools/interview/cli.mjs`（`segment export/apply`、`align export/apply`，均 `--session <id>`）
- Test: `tools/interview/test/segment-align.test.mjs`

**Interfaces (Produces):**
- `segmentExport(root, sessionId)` — 任务 JSON：utterances（id + raw_text + role）+ schema + 原话引用规则（「引用 id，不许改写原话」）。
- `segmentApply(root, sessionId, file)` — 校验每个 `utterance_refs` 存在于 session；写 `sessions/<id>/questions.json` + `question.detected` 事件；`non_question` 不入题队列。
- `alignExport(root, sessionId)` — 每个问题附 `search()` topK 候选（block id + score + question 原文）。
- `alignApply(root, sessionId, file)` — 校验 `matched_block_ids` 存在且 active；`status: matched` 必须 `evidence_refs` 非空（引用 utterance id）；写 `alignment.proposed` 事件；`pending` = 角色/问题未确认，不入统计。

- [ ] **Step 1: 失败测试**：
  - fixture transcript 手工回填 segmentation（虚构 3 问）→ questions.json 3 条；引用不存在 utterance id → exit 2。
  - align apply：matched 指向不存在 block → exit 2；matched 无 evidence_refs → exit 2；`ambiguous`（两个候选块）合法。
  - 重复 `segment apply` 同文件 → 幂等（questions.json 不翻倍，事件不重复）。
- [ ] **Step 2:** FAIL → **Step 3:** 实现 → **Step 4:** PASS → **Step 5:** Commit `feat(interview): segmentation + alignment tasks`。

### Task 17: Rubric 复盘

**Files:**
- Create: `tools/interview/review/rubric.mjs`
- Create: `tools/interview/schemas/review-result.schema.json`（`[{question_id, block_id?, dimensions: {accuracy|coverage|relevance|clarity|boundary_honesty: {score: 0-4|'na'|'unknown', reason, evidence_refs[]}}, fact_conflicts: [{fact_ref, claimed, actual}], new_question?}]`）
- Modify: `tools/interview/cli.mjs`（`review prepare --session`、`review apply --session --file`）
- Test: `tools/interview/test/review.test.mjs`
- Fixture: `tools/interview/test/fixtures/review-result-fixture.json`（含：1 个正确回答、1 个新问题（unmatched）、1 个事实冲突（候选人说 14 节点、块里写 14 节点但回答声称 20 节点——虚构对照））

- [ ] **Step 1: 失败测试**：
  - `review prepare` 任务 JSON 只含 matched 问题 + 对应块全文 + rubric 权重常量（30/25/20/15/10）+「unknown 不判错」「原话引用规则」。
  - apply fixture → `reviews/<id>/review.json` + `review.md` 渲染（每问：原话引用、维度分、冲突、一个练习动作占位）。
  - `fact_conflicts` 非空的块 → 该问 `needs_review: true`，`review.md` 顶部出「事实冲突硬闸门」警示；该块不计 mastery（Task 18 验证）。
  - 维度分 5 分（越界）→ exit 2；`evidence_refs` 指向不存在 utterance → exit 2。
  - unmatched 问题 → 写入 `knowledge/drafts/q-<hash>.md` 待确认新问题种子（`origin_kind: transcript`，`status: queued`），不自动建块。
- [ ] **Step 2:** FAIL → **Step 3:** 实现 → **Step 4:** PASS → **Step 5:** Commit `feat(interview): rubric review`。

### Task 18: 统计与优先级（Heatmap 数据层）

**Files:**
- Create: `tools/interview/core/stats.mjs`
- Modify: `tools/interview/cli.mjs`（`stats [--track <t>] [--round <r>] [--days 180] [--json]`）
- Test: `tools/interview/test/stats.test.mjs`

**Interfaces (Produces):**
- `computeStats(root, { track?, round?, days? })`:
  - eligible sessions = 完成 `align apply` 且问题中无 `pending` 残留、`mode ∈ {real_record_only, real_reference_allowed, historical_import}` 的 session（`mock_*` 全部排除；P1 将 align apply 视为已确认——人工纠正通过重跑 align apply 覆盖，事件留痕）。
  - `frequency = distinct_hit_sessions / eligible_sessions`（同 session 同块多问只计 1 hit）；样本 `n < 5` → 输出 `low_sample: true`。
  - `mastery` = 该块最近 ≤5 次独立回答（session mode 为 mock_blind 或 real_*）的加权均分（0–4 → 0–1）；assisted（mock_assisted/mock_anchor）单列 `mastery_assisted`；有 fact_conflict → `mastery: null` + `needs_review: true`。
  - `priority = 0.25*frequency + 0.35*(1-mastery) + 0.25*relevance + 0.10*risk + 0.05*forgetting`，null 维度剔除后归一；全 null → `priority: null`。
  - 只有 predicted 信号时 → `frequency: null, mastery: null` + `real_samples: 0` + 提示「暂无真实面试样本」。
  - 同 session 重跑 review → 用最新 review 结果，不叠加计数。

- [ ] **Step 1: 失败测试**（用 Task 17 的 fixture session + 一个 mock session 造两组数据）：
  - 只有 CV/JD predicted 信号的全新库 → `frequency/mastery` 均 null、`real_samples: 0`。
  - fixture：1 场 real session 问 demo 块 1 次 + 1 场 mock_blind 答 0.75 分 → `frequency = 1/2`；`mastery ≈ 0.75/4` 归一值；mock_assisted 另加一场 → 不混入 mastery，出现在 `mastery_assisted`。
  - 同 session 同块两问（追问）→ distinct hit 仍 1。
  - 事实冲突块 → mastery null + needs_review。
  - 重复 review apply 后 stats 数值不变（不双计）。
- [ ] **Step 2:** FAIL → **Step 3:** 实现 → **Step 4:** PASS → **Step 5:** Commit `feat(interview): stats/heatmap data layer`。

### Task 19: Patch 生命周期

**Files:**
- Create: `tools/interview/core/patches.mjs`
- Create: `tools/interview/schemas/patch.schema.json`（§6.2 全字段：patch_id/type/target_id/base_revision/before_hash/proposed_diff/reason/source_refs/status/reviewer/created_at；type 枚举 `alias_add|block_add|block_edit|fact_conflict|archive|merge|gap_add`）
- Modify: `tools/interview/cli.mjs`（`patch propose --file` / `patch list` / `patch approve <id>` / `patch reject <id>` / `patch apply <id>`）
- Test: `tools/interview/test/patches.test.mjs`

- [ ] **Step 1: 失败测试**：
  - propose 时 `base_revision` ≠ 当前 revision → 拒绝标 `stale`（中文提示重建提案）。
  - `alias_add` fixture patch → approve → apply 后目标块 `questions` 追加别名，revision +1，manifest 更新，patch `status: applied`。
  - 重复 `patch apply <id>` → 幂等（已是 applied 则 no-op + 提示）。
  - 同 `target_id + diff hash` 的重复 propose → 拒绝（去重）。
  - `fact_conflict` patch apply → 写 `knowledge/fact-links.yml` 的冲突区（不修改 cv.md / ledger.yml，输出提示「走 evolve 审批」）。
  - reject 后同提案再 propose → 允许（人工驱动），但 reject 记录保留。
- [ ] **Step 2:** FAIL → **Step 3:** 实现 → **Step 4:** PASS → **Step 5:** Commit `feat(interview): patch lifecycle`。

### Task 20: 文档 + Demo A/B + 切片 B 收口

**Files:**
- Create: `docs/INTERVIEW-STUDIO.md`（安装、无 Key 体验、`--root` 测试隔离说明、两条 demo 命令序列、隐私边界）
- Create: `tools/interview/eval/demo-a-cv-coldstart.mjs`、`tools/interview/eval/demo-b-transcript-replay.mjs`（各自：建 tmp root → 跑 CLI 子命令序列 → 断言终态；A 含「JD 增量信号」（fixture report 扫描）；B 含 stats + patch apply + 同义问合并去重断言）
- Modify: `modes/interview-review.md`、`modes/interview-evolve.md`、`modes/interview-heatmap.md`（§11 契约模板：review = transcript import → segment → align → review 的 agent 编排；evolve = patch 审批；heatmap = stats 解读）
- Modify: `.claude/skills/career-ops/SKILL.md`、`docs/MODES.md`（三个新 mode 路由行）
- Modify: `package.json`（确认 `test:interview` 同时跑 demo：`"test:interview": "node --test tools/interview/test/ && node tools/interview/eval/demo-a-cv-coldstart.mjs && node tools/interview/eval/demo-b-transcript-replay.mjs"`）

- [ ] **Step 1:** 实现 demo A/B（作为可运行验收，内部复用 cli 子命令进程调用 `node tools/interview/cli.mjs … --root <tmp>`）。
- [ ] **Step 2:** `npm run test:interview` 全绿（含 demo A/B）；demo A 断言：仅 fixture CV、无逐字稿 → ≥1 个 approved 块 + practice 题单非空 + predicted 信号存在且 `real_samples: 0`。demo B 断言：fixture 逐字稿 → review 完成 → stats 有 frequency → 一条 alias_add patch 应用后同义问检索 `hit` 且块数不增加（合并去重）。
- [ ] **Step 3:** 写三个 mode 文件 + 路由 + `docs/INTERVIEW-STUDIO.md`。
- [ ] **Step 4:** 回归：`npm run verify`、`npm run sync-check`、`npm run test:filter`（旧测试）全部不受影响。
- [ ] **Step 5:** Commit `feat(interview): docs + demos A/B (slice B complete, phase 1 done)`。

---

## 验收清单（Phase 1 完成定义，摘自规格 §12）

- 新用户仅 CV、无逐字稿/历史/JD/飞书/API Key → `bootstrap --from cv` → `dig` → `approve` → `practice` 至少 1 个可练习块。
- 无模型时：dig 结果与 drafts 可手工构造 JSON 回填（schema 校验兜底）。
- 跳过 onboarding（不 init）→ 旧工作流零变化（`npm run verify` / scan / pdf 全部照旧）。
- 暂停（`bootstrap --pause` 由 mode 触发 / 手动改 state）→ 恢复不重复提问；CV 更新不覆盖旧答案（blocks 独立于 cv.md，只有 fact_refs 引用）。
- 多份 JD → 只累积 predicted 信号；`stats` 的真实热度/掌握度保持 null。
- ≥2 个虚构 session 验证统计隔离（real vs mock）；导入冲突不激活（needs_review）。
- 未授权不改 cv.md、Tracker、飞书（无任何 `addRound` / tracker 写调用）。

## 执行注意

- 执行前 `git status`：`M modes/contact.md` 是用户未提交修改，**所有 commit 不得包含它**（add 具体文件路径）。
- 每个 task 的测试命令统一 `npm run test:interview`（node --test 全量很快）；单测可用 `node --test tools/interview/test/<file>.test.mjs`。
- 规格原文在 `docs/interview-studio/spec-v0.2.md`，实现中对字段/枚举有疑问以规格为准；计划与规格冲突时停下来问用户。
- 完成后停止，等用户用真实材料验收，再决定 Phase 2（规格附录 A 明确要求）。
