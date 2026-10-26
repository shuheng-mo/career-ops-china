# Mode: evolve — 简历进化（深挖经历 · 事实账本 · cv.md 版本）

`cv.md` 是事实层，但它以前是静态的：没有版本、数字没有出处、投递和面试的反馈也不回流。
这个 mode 让它**带出处、带版本地进化**，而候选人只需要做两件事：**答几道题、批准改动**。

方法论来自职业咨询的「简历事实深挖问卷」流程：先问出具体事实，再改表达；任何数字只能来自候选人本人。

## 子命令

| 命令 | 做什么 | 候选人要做的 |
|---|---|---|
| `evolve init` | 首次建账：快照 cv.md 为基线版本，从 cv.md 抽出全部 claim 建事实账本 | 看一眼 Claude 标的「存疑」对不对 |
| `evolve dig` | 出一轮深挖问卷（≤5 题） | 在对话里答，可以贴语音转写或大白话 |
| `evolve ingest` | 把答案抽成事实写进账本（`dig` 答完后自动接着跑） | 无 |
| `evolve`（默认） | 按账本变化和信号提 cv.md 修改方案 → 批准后改 → 记版本 → 传导 | 逐条批准 |
| `evolve status` | 当前版本、未记录的改动、账本里存疑 / 待确认的数量 | 无 |

## 文件

| 路径 | 内容 |
|---|---|
| `cv-evolve/ledger.yml` | 事实账本（格式见 `templates/evolve/ledger.example.yml`） |
| `cv-evolve/versions/<ver>/` | 每个版本 cv.md 和 cv-*.md 变体的完整快照 |
| `cv-evolve/CHANGELOG.md` | 每个版本改了什么、依据什么、动了哪些 fact |
| `cv-evolve/dig/{YYYY-MM-DD}-round{N}.md` | 每轮问卷题目 + 候选人原话 + 抽取结果 |
| `templates/evolve/question.md` | 单题体例和出题纪律 |
| `templates/evolve/functions/{function}.md` | 职能包：证据维度、高风险 claim 信号、参考样本。`config/profile.yml → evolve.function` 选用，缺省 `tech` |

`cv-evolve/` 整个目录 gitignored，和 cv.md 同一隐私层级。

**版本工具** `npm run cv:version -- <init|status|commit|log|diff|affected>`（`tools/cv-version.mjs`）负责快照、版本号、changelog 和受影响扫描；**不要手写 versions/ 或 CHANGELOG.md**。

---

## 事实纪律（所有子命令都适用）

1. **数字只来自候选人原话或可核对的材料**。不估、不补、不「合理推算」。记不清的写「约 X」并在账本标 `待确认`
2. **证据分级**（写进账本 `grade`）：
   - **A 直接事实**：有具体场景、动作和结果
   - **B 间接证据**：有成果或第三方材料体现，但过程不完整
   - **C 自我陈述**：只有自评，没有事件
   - **D 推断**：来自行业或职级常识，**不能当候选人经历写进 cv.md**
3. **口径必须登记**：百分比、延迟、规模类数字，`source` 写清测试集 / 样本量 / 测量环境。来自 mock、stub、小样本的数字标 `存疑`，直到重测
4. **cv.md 永远是 canonical**。账本只是注释层；两者冲突时以 cv.md 为准并修账本，或者走 evolve 改 cv.md
5. **变体只改写不增事实**：cv-*.md 的规则不变，仍由 `npm run sync-check` 强制
6. **「没有」也是答案**：候选人说没做过 → 账本记 `无此经历`，以后不再问；评估时这类缺口直接按缺口处理，不再白挖

---

## `evolve init`

1. `npm run cv:version -- init` —— 基线快照（已初始化会报错，改跑 `status`）
2. 读 `cv.md`，**每个带单位的数字**（百分比、人数、条数、延迟、节点数……，与 `tools/cv-facts.mjs` 的 `extractClaims` 一致）建一条账本，外加每段经历的角色 / 团队规模这类关键非数字事实
   - `id`：`{段落 slug}.{事实 slug}`，例如 `projA.exec_success_rate`
   - `claim`：cv.md 里能唯一定位它的最短原文片段（含数字和单位）
   - `grade` / `status`：按 cv.md 里给出的上下文判断。已知口径有问题的（memory、`_profile.md` 里提到过的）直接标 `存疑` 并写明原因
   - 同一个数字在 cv.md 里代表两件事（例如两处都是 85% 但一个是召回率一个是成功率）→ 拆两条，`claim` 片段要能区分
3. 写 `cv-evolve/ledger.yml`
4. 跑 `npm run sync-check`，它会列出账本没覆盖的 claim，补齐到零
5. 汇报：总条数、各 grade 数量、存疑清单，并对每条存疑跑一次 `npm run cv:version -- affected --fact <id>`，告诉候选人有多少份**已投在途**的简历带着它

## `evolve dig`

1. 读职能包 `templates/evolve/functions/{function}.md` 和 `templates/evolve/question.md`
2. 选题，**最多 5 题**，按优先级：
   1. 被面试官追问过 / 答崩过的 claim：Interviews 表 `feedback`（`npm run interview -- list`）、`interview-prep/mock-interviews/*.md`
   2. 账本里 `存疑` 的 claim
   3. 高频 JD 缺口：最近 30 天 `reports/*.md` Block B 里判「弱 / 无」、且对应 Tier A/B 的行，按出现次数排（**跳过账本里已是 `无此经历` 的**）
   4. 账本里 C / D 级、或命中职能包「高风险 claim 信号」的
3. 每题按 `templates/evolve/question.md` 的体例写，「为什么问」里**写明信号来源和次数**
4. 写入 `cv-evolve/dig/{date}-round{N}.md`，然后在对话里**一次一题**问候选人
5. 候选人可以随时说「先到这」：已答的题照常 ingest，没答的留到下一轮

## `evolve ingest`

对每道已答的题：

1. 把候选人原话**原样**存进 dig 文件该题下面
2. 抽事实：新事实 → 新增账本条目；补充了口径 / 细节 → 更新已有条目的 `source` / `grade` / `status`；「没有」→ `无此经历`
3. 判 grade 时按上面的分级，宁低勿高
4. 模糊处不脑补：标 `待确认`，并把要确认的点写进 `note`
5. 回显一张表：fact id / 变化 / 新 grade / 新 status。**这一步只改账本，不碰 cv.md**

## `evolve`（默认）

1. `npm run cv:version -- status`：如果 cv.md 有没记版本的手工改动，先问候选人这些改动的原因，提交成一个版本
2. 收集改动依据：
   - 账本上次版本以来的变化（新事实、grade 升级、`存疑` 被澄清或证实）
   - `output/cv-candidate-*.md` 里**被 ≥3 份定制简历反复采用的同一种改写**（说明这种说法更好用）——只取措辞，不取数字
3. 出修改方案，**每条一个 diff 片段 + 依据**（fact id 或信号来源）。规则：
   - 只用 A/B 级、`已确认` 的事实；`待确认` 的先不进 cv.md
   - `存疑` 的数字：有重测结果就替换，没有就改成不带具体数字的表述，或者加上口径（「在 N 条测试用例上」）
   - 不新增技能、雇主、日期、学历
4. 候选人逐条批准 / 驳回 / 修改。驳回的写进 changelog 的摘要里（下次不再提同样的方案）
5. 改 cv.md，然后提交版本：
   `npm run cv:version -- commit -m "一句话摘要" --facts id1,id2 --signal "依据"`
6. **传导**（不需要候选人动手，Claude 依次做完再汇报）：
   - `npm run sync-check`：变体如果引用了被改掉的事实会报错，按 cv.md 的新说法同步改 cv-*.md，再提交一个版本
   - `npm run cv:version -- affected --since <上一版本>`，结果分三组处理：
     - **未投 → 重新生成**：列出来，问候选人要不要现在批量重生成（走 `pdf` mode）
     - **已投在途 → 不改**：HR 和面试官手里是旧版。在 `interview-prep/story-bank.md` 对应故事下加一行「#N 投的是 `<旧版本>`，面试按旧口径讲，或主动说明『后来重测了，结果是……』」
     - **已结束**：只报数量
   - 改动涉及 story-bank 里的故事 → 提示跑 `/career-ops story-sync` 增量
7. 汇报：新版本号、改了几条、传导结果

---

## 和其他 mode 的关系

- **`pdf`**：生成定制简历前跑 `sync-check`，账本里 `存疑` 的 claim 还在 cv.md 里时会告警——告警时在交付说明里提一句，问候选人要不要先 `evolve`
- **`story-sync`**：story-bank 的 S/T/A/R 用 cv.md 当前版本的事实；版本变更后要增量同步
- **评估（Block B）**：账本里 `无此经历` 的条目是确定的缺口，不要在 Block B 里把它写成「可能有、待挖」

## 永远不要

1. 在问卷样本或修改方案里写候选人没说过的数字
2. 改已投在途的定制简历（会和 HR 手里那份对不上）
3. 跳过 `cv:version commit` 直接改 cv.md —— 那正是这个 mode 要消灭的「无迹可寻」
4. 把账本、dig 答案、版本快照的内容写进任何会入库的公开文件（modes、templates、tools、docs）
