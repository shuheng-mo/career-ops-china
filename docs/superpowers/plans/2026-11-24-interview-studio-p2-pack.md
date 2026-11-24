# Interview Studio Phase 2 实现计划（Interview Pack Compiler）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（本会话已确立 native 模式）。Steps 用 checkbox。

**Goal:** 按 `docs/interview-studio/spec-v0.2.md` §7 + §12 P2 实现 Pack Compiler：`pack build --application N --round R [--minutes 60]` 从 tracker 真实投递记录 + report + CV + 知识块编译企业面试包（含考前一页、覆盖缺口、硬闸门），可冻结回放。

**Architecture:** 复用 P1 全部地基（blocks/stats/validation/storage）。packs/ 新增 compile.mjs（确定性选块 + 来源收集）+ render.mjs（Markdown 渲染 + freeze）。tracker 读取经 tracker-backend `listApplications()`，测试用 `--fixtures-tracker/--fixtures-rounds` 注入（ADR）。

**Tech Stack:** 同 P1（Node ESM、yaml/ajv、node:test），新增只读依赖零。

**Spec:** docs/interview-studio/spec-v0.2.md §7（Pack Compiler 全文）+ §12 P2 验收。

## Global Constraints（P2 增量）

- 数据来源必须真实可溯：tracker 行（num/company/role/track/status）、report 文件（Block A-F + URL 头）、CV（当前 cv.md + SHA256；投递过 PDF 时记录其存在，**不能拿当前 CV 假装当时版本**——cv_source 显式标注）、前轮反馈（listRounds 只读；不可用则空 + 注明）
- 公司资料必须带 retrieved_at（= report 日期）与 freshness 判定（>7 天提示「面试前再查」，>30 天标过期）；**禁止编造新信息**
- 知识库为空或关键块缺失 → 输出 coverage_gaps（≤5 补齐问题），可用已确认块编译部分包
- needs_review 块必须进「硬闸门」段落，不得混入正文
- 同输入同版本 → 编译确定性可复现（sort + tie-break by block_id）
- 所有新个人 claim 必须指向 confirmed 事实（块内容已在 P1 审批过，pack 不新增 claim）
- freeze 后不可变；重编译产生新 pack_id
- 测试禁触真实 tracker/Bitable（fixtures 注入）；其余全局约束沿用 P1 计划

## Review Focus

1. **freshness 谎报**：report 超期必须降级警示，不得假装新鲜
2. **CV 混淆**：当前 cv.md ≠ 投递版时必须显式标注，不得静默
3. **tracker 缺号**：`--application` 不存在 → exit 4，不自行创建
4. **确定性**：同输入两次 build → pack.json 内容一致（除 created_at/pack_id）
5. **硬闸门**：needs_review 块进包必须带闸门标记，不得无提示混入

---

### Task 1: 来源收集（context gather）

**Files:** Create `tools/interview/packs/context.mjs`、`schemas/pack.schema.json`（§7 pack.json 字段）、`tools/interview/test/pack-context.test.mjs`、fixtures（fictional tracker JSON + report md）

**Interfaces (Produces):**
- `gatherContext(root, { applicationNum, round, trackerFile?, roundsFile? })` → `{ application, report, cv: {source, hash}, research: [{claim, retrieved_at, freshness}], rounds_feedback, warnings[] }`
- tracker 缺号 → ValidationError（exit 4）；report 文件缺失 → warning + 空 report；freshness：days>30 → 'expired'、>7 → 'stale'、else 'fresh'

- [ ] 失败测试：fixtures tracker 有 #901（report 存在）与 #902（report 缺失）两条 → gather 断言各自路径；缺号 #999 → 抛；report 日期 40 天前 → freshness expired
- [ ] 实现 → 测试绿 → commit

### Task 2: 编译（选块 + coverage_gaps + pack.json）

**Files:** Create `tools/interview/packs/compile.mjs`；Modify cli（`pack build`）

**Interfaces (Produces):**
- `compilePack(root, ctx, { prepMinutes })` → pack.json 对象（写入 `packs/<pack_id>/pack.json`）
- 选块规则：track 命中优先 → stats 优先级降序 → criticality high 先行 → budget 内截断（estimated_minutes 默认 criticality high 15 / normal 10 / low 5）；needs_review 块入 `hard_gates` 不入 selected
- coverage_gaps：queued 种子（同 track）按优先级取 ≤5

- [ ] 失败测试：两块（一 normal 一 needs_review）→ selected 只含 normal、hard_gates 含另一；budget 15 → 只装 high 块；同输入两次 compile → 除 pack_id/created_at 外字段一致；queued 种子进 coverage_gaps ≤5
- [ ] 实现 → 绿 → commit

### Task 3: 渲染 + freeze + 文档路由

**Files:** Create `tools/interview/packs/render.mjs`；Modify cli（`pack freeze/list/show`）、docs/INTERVIEW-STUDIO.md、modes/interview-prep.md（pack 段）、ADR 追加

- [ ] 失败测试：render 产出含「考前一页」「硬闸门」「覆盖缺口」「反问」段；freeze 后再 render 输出不变（幂等）；freeze 后 compile 同输入产生新 pack_id
- [ ] 实现 → 绿 → 全量回归（test:interview + verify + sync-check）→ commit

### 验收（§12 P2）

同一虚构候选人三种 JD/轮次产出侧重点不同的包；缺 report/资料时显式降级；旧 pack 不受新知识版本影响（kb_revision 记录在案）。
