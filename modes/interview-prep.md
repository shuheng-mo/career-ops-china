# Mode: interview-prep — 面试知识库（Interview Brain · 冷启动 → 练习题单）

从零（或从已有逐字稿）建立可版本化的面试知识库：CV → 候选问题 → 深挖 → 草稿审批 → 练习题单。
规格：`docs/interview-studio/spec-v0.2.md`（§4.2.1）；ADR：`docs/interview-studio/decisions.md`。

## 何时用

- `/career-ops interview-prep init` — 首次建库（CV-only 冷启动，可跳过逐字稿导入）
- `/career-ops interview-prep dig` — 一轮深挖（≤5 题，候选人答 / 跳过 / 记不清 / 没做过）
- `/career-ops interview-prep import` — 已有逐字稿 / mock 笔记导入（走同一审批路径）
- `/career-ops interview-prep status` — 库状态 + 信号对账

## CLI 映射（确定性操作全部走 CLI，agent 不直接改知识库文件）

| 动作 | 命令 |
|---|---|
| 建目录 | `npm run interview:kb -- init` |
| CV 冷启动 | `npm run interview:kb -- bootstrap --from cv [--cv <路径>]` |
| 看进度 | `npm run interview:kb -- bootstrap status` |
| 列种子 | `npm run interview:kb -- seed list [--status queued]` |
| 出题 | `npm run interview:kb -- dig prepare` |
| 收答案 | `npm run interview:kb -- dig ingest --file <result.json>` |
| 导出草稿任务 | `npm run interview:kb -- drafts export --json` |
| 审批激活 | `npm run interview:kb -- approve --file <drafts.json>` |
| 练习题单 | `npm run interview:kb -- practice [--track <t>]` |
| 信号对账 | `npm run interview:kb -- signals reconcile [--scan-reports] [--check-cv]` |

## Agent 编排流程

### init（首次）

1. `init` → `bootstrap status`。若 `dismissed: true` 或已有数据，只报状态不重复邀请。
2. `bootstrap --from cv`（读 cv.md，默认仓库根；可 `--cv` 指定）。逐字稿导入**可选**——没有也能冷启动。
3. `seed list` 展示首批种子（≤10），告诉候选人：「这些是候选问题，不急着答」。

### dig（深挖，一轮 ≤5 题）

1. `dig prepare` 拿题，**在对话里一次一题**问候选人。
2. 候选人四种回答都合法：**答**（记原话）/ **跳过**（留到下轮）/ **记不清**（标 needs_input，不编造）/ **没做过**（dismissed + 无此经历，以后不再问）。
3. 结束后把结果写成 dig-result JSON 并 `dig ingest`。示例：

```json
{"results": [
  {"seed_id": "…", "status": "answered", "raw_answer": "候选人原话，一字不改"},
  {"seed_id": "…", "status": "skipped"}
]}
```

### drafts（起草 → 审批，硬闸门）

1. `drafts export --json` 拿任务（含候选人原话）。
2. 按输出 schema（answer-draft）生成草稿。**契约（规格 §11）：**
   - **允许的事实引用**：`cv:<ledger-id>`（evolve 账本已确认条目）、`tech:<id>`（tech-facts.yml confirmed）、或 `source locator + pending`（未启用 evolve 时，明确标注待确认）。
   - **输出限制**：markdown 三段「## 30 秒版 / ## 详细版 / ## 技术边界」；30 秒版 ≤150 字；技术边界必须写「哪些没做」。
   - **原话证据规则**：30 秒版里的每个事实性表述必须能追溯到 raw_answer 或 fact_refs；不得改写数字与口径。
   - **unknown 分支**：原话没覆盖的点 → 写「（此点原话未覆盖，待确认）」，不得脑补；claim_kind 用 `knowledge`/`design`（不是 `experience`）。
   - **批准门槛**：草稿先展示给候选人（来源 + 待确认项 + diff），**明确确认后才跑 approve**；未确认的事实永远进不了 active 块（CLI 会拒 experience + 未确认 fact_refs）。
3. `approve --file <drafts.json>` → 块激活、种子 linked、bootstrap state=ready。

### practice（交付）

`practice --track <目标track>` 输出题单（问题 + 锚点 + 30 秒版）。这是 P1 的最终交付物——不依赖 UI/ASR。

### pack（考前编译）

面试邀请来了 → `pack build --application <num> --round <轮次>`：从 tracker 取真实投递记录和评估报告（公司资料带 freshness，过期必警示）、按 track/优先级选知识块、needs_review 块单独成硬闸门段、时间预算截断并显示未覆盖。编译后**人工过一遍硬闸门和覆盖缺口**，确认无误再 `pack freeze`。冻结后的包不随后续知识演进变化——可回放、可对照。

### signals（增量信号）

- 评估 mode（auto-pipeline/offer/batch）**report 成功落盘后**：跑一次
  `signals reconcile --scan-reports`（ADR-0001 #3：mode 末尾登记 + 显式补扫）。
- CV evolve 批准新版本后：`signals reconcile --check-cv`（受影响块会被标记需复核）。
- 未启用（`interview.enabled: false`）时这些命令是 no-op，不影响旧流程。

## 与其他模块的边界

- **story-sync 兼容（ADR-0001 #1）**：本模块**只读** `interview-prep/story-bank.md`（可作为 import 输入），**绝不写它**；story-sync 依旧独占写。两处表达不一致时以候选人审批后的知识块为准。
- **cv.md canonical 不变**：知识块只引用事实（fact_refs），不产生新事实；面试暴露的事实缺口走 `evolve dig` 提案。
- **Tracker / 飞书**：本模块不写 tracker、不发飞书消息、不调用 `addRound`。

## 未启用时

`interview.enabled: false`（默认）→ 不邀请、不收集信号；用户显式 `init` 才生成本地文件。跳过本 mode 不影响任何旧流程。
