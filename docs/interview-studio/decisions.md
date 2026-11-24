# Interview Studio — 决策记录（ADR）

每个决策一行一条，格式：`ADR-N | 日期 | 决策 | 理由 | 代价（如果错了）`。

## ADR-0001 | 2026-11-24 | Phase 0 基线核对结果与兼容方案

实现基线（规格 §0 要求开工时核对）：

- HEAD：`1cb80d3`（feat(tracker): 招聘阶段口径整改）；Node v22.23.0（规格建议 22/24 LTS ✓）。
- `package-lock.json` 存在；测试模式 = 独立 `tools/test-*.mjs` 直跑 + npm script（无集中 runner、无 node:test）——新模块用 `node:test` + `node --test tools/interview/test/`，npm script `test:interview`，与现有 `test:*` 并列。
- 隐私检查：`git ls-files interview-prep cv-evolve` 输出为空 ✓；`.gitignore:96` `interview-prep/*` 全目录忽略 ✓；`cv-evolve/` 忽略 ✓。新增公开路径仅 `tools/interview/`、`templates/interview/`、`docs/interview-studio/`、`apps/`（P3 起），均不含个人数据。
- 接口面（开工时核实）：
  - `tools/feishu/interviews.mjs` 导出 `ROUNDS`（第 39 行，由 `INTERVIEW_STAGES` 过滤而来）、`ensureTable()`、`listRounds(num)`、`addRound(r, {rollup})` —— Interview 模块**只导入 `ROUNDS` 做轮次白名单**，绝不调用 `addRound`/`ensureTable`（规格 §2）。
  - `tools/cv-facts.mjs` 导出 `readLedger()`、`parseLedger(text)`、`extractClaims/extractNumbers` —— signals `--check-cv` 复用 `readLedger`。
  - `tools/cv-version.mjs` 子命令 `init/status/commit/log/diff/affected` —— interview 模块不改它，fact 变化检测只读账本。
- Skill 路由入口：`.claude/skills/career-ops/SKILL.md`（Mode Routing 表 + argument-hint + Standalone modes 列表）+ `docs/MODES.md` 模式表。

### 兼容决策

| # | 决策 | 理由 | 代价 |
|---|------|------|------|
| 1 | 不新建独立故事库：`interview-prep/story-bank.md` 保持 story-sync 独占写；interview 模块把它当**可选导入源**（经 `import` 审批路径），绝不写它 | 规格 §2 | 两套故事表达可能漂移；导入审批时人工对齐 |
| 2 | onboarding 邀请落在 `SKILL.md` 路由 + `CLAUDE.md` onboarding Step 6 末尾一行（可跳过）；不改 onboarding 其余流程 | 规格 §4.2.1「CV onboarding 完成后一次性可跳过邀请」 | 用户不用 skill 入口就看不到邀请；CLI 直跑 `interview:kb init` 不受影响 |
| 3 | report 落盘登记采用「mode 末尾登记指令（提示词层）+ `signals reconcile --scan-reports` 显式补扫（代码层）」，不做单点代码 hook | 规格 §4.2.1 明确允许此组合，要求写明 ADR | mode 忘记登记时有补扫兜底；补扫只登记 report 级信号，问题级信号靠 mode |
| 4 | CLI 增加 `--root` / `--cv` 注入旗标，仅供测试与 synthetic demo 隔离；默认值不变（`<repo>/interview-prep`） | 规格 §13 测试禁止访问真实 interview-prep/Tracker | 若有人把 `--root` 用于生产多实例，无单写者跨进程保证（P1 范围内 lock 是文件级） |
| 5 | 新依赖只加 `yaml` ^2 + `ajv` ^8（规格 §3.1 授权）；schema 校验器选 Ajv | 规格「JSON Schema + Ajv 或仓库已有等价校验器，选择一个」 | 供应商锁定的风险 = 两个纯 JS 库，可替换 |
| 6 | spec 文档随仓库提交：`docs/interview-studio/spec-v0.2.md`（从仓库根移入，内容逐字未改） | 实现契约需要与代码同行；文件无个人数据（个人逐字稿 v2.6 仅被引用不包含） | 公开仓库可见产品规格——规格本身设计为对外叙事的一部分（§14） |

### P1 明确不做（规格 §12 Later / P2+）

Pack Compiler（P2）、localhost UI/Studio（P3）、ASR 与实时定位（P4）、飞书同步、Tencent/火山/Paraformer ASR adapter、自动删除低频问题、LLM 判分当真值。
