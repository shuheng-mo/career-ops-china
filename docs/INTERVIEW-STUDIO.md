# Interview Studio — 面试准备、实战复盘、记忆训练与知识演进

> 状态：**P0+P1 已实现（shipped）**；Pack Compiler（P2）/ 本地 UI（P3）/ 实时 ASR 提词（P4）为 planned，未实现的功能不在本文档里冒充已支持。
> 规格：[`docs/interview-studio/spec-v0.2.md`](interview-studio/spec-v0.2.md) · 决策记录：[`docs/interview-studio/decisions.md`](interview-studio/decisions.md)

## 这是什么

面试工作台闭环：**Interview Brain**（从 CV/逐字稿逐步建立可版本化的知识块、问题索引与事实引用）+ **Interview Replay**（逐字稿导入 → 问题对齐 → rubric 复盘 → 事实冲突闸门 → 改进队列）+ **Heatmap**（真实面试频率 k/n、掌握度、复习优先级）+ **知识演进**（patch 提案逐条审批）。

**逐字稿不是必需品**：新用户仅凭 CV 即可冷启动（onboarding 可跳过）。

## 安装与无 Key 体验

```bash
npm install        # 依赖：yaml / ajv（P1 新增，均纯 JS）；已装则跳过
npm run interview:kb -- doctor    # 环境体检（node ≥22 / 依赖 / 数据目录可写 / 配置）
npm run interview:kb -- init        # 建本地数据目录（幂等）
npm run interview:kb -- bootstrap --from cv   # CV 冷启动生成种子问题
npm run interview:kb -- dig prepare # 出 ≤5 题深挖问卷
# （在对话里答完）→ dig ingest → drafts export → approve → practice
```

**全程不需要任何 API Key**：确定性操作（校验/存储/检索/统计）全部本地；语义任务（问题切分、对齐、判分草稿）走「CLI 导出任务 JSON → agent 回填 → CLI 校验提交」的离线路径，人工标注也可以手工构造 JSON 回填。默认 `interview.enabled: false`——不 init、不启用，旧流程零变化。

## 两条完整 synthetic demo（无需任何真实数据）

```bash
node tools/interview/eval/demo-a-cv-coldstart.mjs
# 仅虚构 CV → 种子 → 深挖 → 审批 → 首批练习题单 → JD 增量信号；断言真实热度保持 null

node tools/interview/eval/demo-b-transcript-replay.mjs
# 虚构逐字稿 → 对齐 → 复盘（含事实冲突闸门）→ 真实统计 → patch 应用与同义问合并去重
```

两/demo 均在临时目录运行，**绝不触碰真实 `interview-prep/`**；`npm run test:interview` 会同时跑全部单测与两条 demo。

## CLI 命令一览（`npm run interview:kb -- <command>`）

| 命令 | 用途 |
|---|---|
| `init` / `doctor` | 建目录（幂等）/ 环境体检 |
| `validate --file <block.md>` | 校验知识块 front matter（answer-block schema） |
| `bootstrap --from cv [--cv <路径>]` / `bootstrap status` | CV 冷启动 / 进度 |
| `seed list` | 列种子（候选问题） |
| `dig prepare` / `dig ingest --file <result.json>` | 深挖 ≤5 题 / 收答案（答/跳过/记不清/没做过） |
| `drafts export` / `approve --file <drafts.json>` | 导出草稿任务 / **人工批准后**激活知识块 |
| `practice [--track <t>]` | 输出可练习题单（问题+锚点+30秒版） |
| `import --file <笔记.md>` / `import apply --file <candidates.json>` | 已有逐字稿/笔记导入（与 CV-only 共用审批路径） |
| `transcript import --file <md\|srt\|json> [--application N] [--round 一面]` | 逐字稿标准化（重复导入自动复用） |
| `segment export/apply` / `align export/apply --session <id>` | 问题切分 / 知识块对齐 |
| `review prepare/apply/show --session <id>` | rubric 复盘（30/25/20/15/10，冲突硬闸门） |
| `stats [--track] [--round] [--days 180]` | 频率 k/n、掌握度、优先级 |
| `signals reconcile [--scan-reports] [--check-cv]` | JD/Block F 信号登记 + CV 账本增量核验 |
| `patch propose/list/approve/reject/apply` | 知识演进（同义问/改块/事实冲突/归档/合并） |

Agent 编排入口：`/career-ops interview-prep`、`/career-ops interview-review <num>`、`/career-ops interview-evolve`、`/career-ops interview-heatmap`。

## 数据与隐私

- 全部个人数据在 gitignored 的 `interview-prep/`：`imports/`（原件+SHA256）、`knowledge/`（块/种子/信号/版本 manifest）、`sessions/`、`reviews/`、`patches/`
- **测试与 demo 用 `--root <临时目录>` / `--cv <虚构 fixture>` 注入**，自动化永不读写真实数据目录（ADR-0001 #4）
- 不联网、不上传：无云端 ASR、无 embedding、无 LLM 调用（P4 起云端服务默认关闭，启用是显式决定）
- 不写 Tracker、不发飞书消息、不调用 `addRound`；cv.md 与 evolve 账本只被引用，永不被本模块改写
- 删除：整目录删除 `interview-prep/` 即可（派生 cache 可重建）

## 已知限制（P1）

- 检索为纯词法（BM25 + 中文 bigram）；阈值保守，改写问句走「候选展示 + 人工确认」而非自动跳
- 角色（面试官/候选人）只认显式标签，无标签的逐字稿保持 unknown，需人工确认
- 高并发分布式评分、语速语气等不可从文本推断的维度一律 unknown，不判错
- 优先级公式中 relevance 维度在 P1 恒为 null（无 JD 关联数据）
