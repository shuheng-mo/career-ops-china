# Mode: offer — 单岗位完整评估（A-F 六块）

候选人贴一个职位（文本或 URL）时，**必须按顺序输出 A-F 六个 block**。

## Step 0 — Track 归类 + Tier 归类（评估前置，必须先于 Block A）

### 0.1 定 Track

读 `modes/_profile.md` 的 **Track 表**。两步交叉：

1. **domain** — 这家公司/这个岗位是汽车、智驾、Tier1 供应商吗？
2. **archetype** — 核心职责落在哪条技能轴（AI 应用/Agent · 数据闭环/数据平台 · 感知/规控算法 · 数据工程 bridge · 数据治理 bridge）

交叉查表得到 track_id，6 个合法值：`ai-app` / `ai-app-auto` / `auto-data` / `auto-algo` / `ai-data-bridge` / `ai-gov-bridge`。混合型标最近的一个并在 Block A 说明理由。

**Track 决定四件事：**
- **CV 选源** — `ai-app` 系用 `cv.md`，汽车系用 `cv-auto.md`（缺失则回落并标注）
- **北极星对齐度的评分上限** — 按 `fit`：primary 5.0 / secondary 4.0 / bridge 3.5
- **投递闸门** — 见 `modes/_shared.md` 的闸门表（汽车轨要更高分）
- Block B 的 proof point 优先级、Block E 的 summary 改写、Block F 的 STAR 选材（见 `_profile.md` 的「按 Track 自适应包装」表）

⚠️ `auto-data` **只在车企/智驾场景成立**。判据是「这份数据工作是不是服务于智驾/车端」，不是「JD 里有没有数据字样」。普通互联网数仓/数据分析岗仍按 deal_breakers SKIP。

### 0.2 Tier 硬筛

`_profile.md` 中标记为"已弃用"的 archetype，JD 命中且与核心 archetype 无强重叠 → 直接 SKIP。
⚠️ **先看那张表右列的「汽车轨例外」** —— 「后端工程师」「AI Infra」「纯数仓」这三条对汽车轨有例外，不加判断就 SKIP 会把整条汽车轨毙掉。

对未跳过的岗位，按 `modes/_shared.md` 的 Tier 检测规则执行（对照 `config/target_pool.md`）：

1. **真实门槛硬筛**：JD 命中 `target_pool.md` 中 Tier D 触发关键词 → **立刻 SKIP**，不浪费 token
2. **Tier 归类**（写入 report 头）：对照 `target_pool.md` 的 Tier A/B/C/D 清单 + 画像反推
3. Tier A/B/C → 进 Block A-F 全评估，然后查 `_shared.md` 的**投递闸门表**（`fit` × Tier）
4. Tier D → SKIP，写一句理由

### 0.3 证据闸门（仅 track = `auto-algo`）

完整规则见 `modes/_profile.md` 的「证据缺口闸门」段。要点：

- **不走 SKIP，走 `Status = Blocked`** —— 活态、可解锁。SKIP 是终态会自动打 `Closed At`，漏斗里算死
- 数 evidence 表里 ✅ 的个数 `E`
- **`E < 2`** → 照常出完整 A-F（Block B 的 gap 分析就是闸门的输入），但 `Status = Blocked`、**不生成 PDF、不进投递候选**，notes 写 `证据缺口 E=N/4，缺 {missing ids}`
- **`E ≥ 2` 且该 JD 的 hard requirement 全部被已有 evidence 覆盖** → 解锁，按 secondary 闸门走
- 额外输出 **Block B2 — 证据缺口清单**（见下）

## Block A — 角色摘要

输出一张表，包含：
- **Archetype**（检测到的）
- **Domain**（数据 / 大模型 / 后端 / 平台 / 算法）
- **Function**（建设 / 维护 / 治理 / 落地 / 架构）
- **Seniority**（初级 / 中级 / 高级 / 资深 / 专家 / 架构师 — 同时给出大厂职级对标，如 P6/P7/T2.2 等）
- **业务方向**（推荐 / 风控 / 增长 / 中台 / SaaS / ToB / ToC ...）
- **远程政策**（onsite / 混合 / 全远程）
- **Base 城市**（北京/上海/深圳/杭州/...）
- **团队规模**（如 JD 提到）
- **公司类型**（大厂 / 大模型独角兽 / 中小创业 / 外企 / 国企）
- **TL;DR**（一句话）

## Block B — CV 匹配

**读 Step 0.1 定下的 track 对应的 CV 文件**（`ai-app` 系 → `cv.md`；汽车系 → `cv-auto.md`，缺失则回落 `cv.md` 并在 report 里标注）。建一张表：JD 的每条要求 → 候选人 CV 中的具体行。

**按 track 调整优先级：**

| track | 优先突出 |
|---|---|
| `ai-app` | RAG/Agent 架构、Eval 体系、Prompt 工程、向量检索、多模型路由、成本与时延、上线效果 |
| `ai-app-auto` | 同上，但把叙事挂到车载场景：多模型路由 → 车端/云端分流；Eval 闭环 → 安全关键场景的质量门；成本控制 → 车厂对单次调用成本极敏感；可观测性 → 车队规模的监控 |
| `auto-data` | 数据治理的体系化能力 + 元数据/血缘 → 迁移到「路测数据资产化」；分层数仓（ODS/DWD/DWS）与数据质量闭环；跨部门推动落地 |
| `auto-algo` | ⚠️ **诚实承认 gap，不要硬包装。** 能讲的只有工程化那一面（数据管线、Eval 体系、可观测性）；感知算法本身没有证据 —— 这正是 Block B2 要列的东西 |
| `ai-data-bridge` | NL2SQL/ChatBI 端到端、数据治理 + LLM、Agent SQL |
| `ai-gov-bridge` | 元数据/血缘/质量平台、跨部门推动、主数据、合规、数据资产 |

输出一个 **gaps 段落**，对每个 gap 给出缓解策略：
1. 是 hard blocker 还是 nice-to-have？
2. 候选人能否用相邻经验论证？
3. 有没有作品集/GitHub 项目能填补这个 gap？
4. 具体的缓解动作（cover letter 的一句话 / 一个快速 side project / 引用某个开源贡献等）

## Block B2 — 证据缺口清单（**仅 track = `auto-algo`**）

其它 track 跳过这一块。

逐条列出 JD 的 hard requirement 对照 `modes/_profile.md` 的 evidence 表：

| JD 硬要求 | 对应 evidence_id | 现状 | 最小补齐动作 | 预估工时 |
|---|---|---|---|---|
| （如 "熟悉 BEV 感知"）| `bev-occ` | ❌ | （如 "跑通一个开源 BEVFormer，在 nuScenes mini 上出可视化结果，写 README"）| （如 "2-3 周"）|

末尾给一行结论：`证据缺口 E=N/4，缺 {missing ids}` → 决定 `Status = Blocked` 还是解锁。

**这一块的意义**：把「HR 初筛就挂」（`#62 佑驾创新` 的真实结果）转成一个可执行的待办队列。补齐 2 项以上这一轨就自动解禁，不需要改规则。

## Block C — 级别与策略

1. **JD 暗示的级别** vs **候选人在这个 archetype 下的自然级别**（用 `_shared.md` 的职级对标表反推）
2. **「不撒谎卖资深」方案**：
   - 具体话术（适配 archetype）
   - 要重点拎出的成就
   - 把"独立从 0 到 1"经历包装成优势
   - 把"跨部门协作"或"踩过的坑"包装成 senior signal
3. **「如果被压级」方案**：
   - 如果 comp 合理可以接受 → 谈定 6 个月内 review 条件
   - 列清楚晋升标准
   - 接受降级的边界（薪酬不能低于 X / 不能进非核心团队）

## Block D — 薪酬与需求（中国大陆数据源）

⚠️ **不要用 Glassdoor / Levels.fyi / Blind**，国内公司在这些站基本没有数据。

用 WebSearch 查以下中文源：

| 源 | 用法 | 适合查什么 |
|----|------|----------|
| **看准网（kanzhun.com）** | `site:kanzhun.com {公司} 薪资` | 平均薪资、各级别区间、口碑评分 |
| **脉脉职言区（maimai.cn）** | `site:maimai.cn {公司} 薪资` 或 `{公司} P7 脉脉` | 真实匿名薪酬讨论、近期发包情况 |
| **OfferShow（offershow.cn）** | `site:offershow.cn {公司} {职级}` | 应届/社招的真实 offer 数据 |
| **知乎** | `site:zhihu.com {公司} 薪资` 或 `如何评价 {公司}` | 详细的口碑、加班、文化讨论 |
| **一亩三分地** | `site:1point3acres.com {公司}` | 国内大厂讨论 |
| **leetcode.cn** | `site:leetcode.cn {公司} 面经` | 应届/社招面经 |
| **互联网职级对标** | `互联网 职级对标 {公司}` | 反推 JD 暗示的级别对应哪个 P/T/L |

**Block D 输出表格：**

| 维度 | 数据 | 来源 |
|------|------|------|
| 薪资带宽（base + 年终） | xx-xx K × 16/15/14 | 看准/脉脉 |
| 股票/期权（如有） | xxx 万 RMB / 4 年 | 脉脉/OfferShow |
| 工时强度 | 大小周 / 996 / 11-9-6 / 双休 | 知乎/脉脉 |
| 公司口碑 | x.x / 5（看准） | 看准网 |
| 业务/团队近况 | 扩招 / 优化 / 稳定 / 风险 | 脉脉/新闻 |
| 这个岗位的市场需求 | 紧缺 / 普通 / 饱和 | 脉脉招聘讨论 |

**如果查不到数据，明说"未查到，建议向脉脉/知乎匿名提问"，不要编造。**

**Comp Score（1-5）：**
- 5 = 头部分位，明显高于市场
- 4 = 高于市场
- 3 = 市场中位
- 2 = 略低于市场
- 1 = 明显低于市场或工时严重不匹配

## Block E — 个性化方案

| # | 部分 | 现状 | 修改建议 | 为什么 |
|---|------|------|---------|--------|
| 1 | Summary | ... | ... | ... |
| ... | ... | ... | ... | ... |

**Top 5 CV 修改 + Top 5 LinkedIn/脉脉资料修改**，最大化 ATS 匹配 + HR 第一眼注意力。

中国大陆 CV 的特殊建议：
- 是否需要加证件照（看公司类型决定，互联网大厂一般不需要）
- 出生年月 / 性别 / 婚育（互联网行业可省，国企/外企看情况）
- 项目经历的描述模式："**业务背景** → 我的角色 → 技术方案 → **量化结果**"
- 学历放显著位置（国内 HR 第一眼就要看）

## Block F — 面试准备

6-10 个 STAR+R（Situation + Task + Action + Result + **Reflection**）故事，对应 JD 的核心要求：

| # | JD 要求 | STAR+R 故事 | S | T | A | R | Reflection |
|---|--------|------------|---|---|---|---|-----------|

**Reflection 列**：当时学到了什么 / 现在回头看会怎么改。这是区分中级和高级的关键 — 中级讲做了什么，高级能从中提炼出 lesson。

**Story Bank**：如果 `interview-prep/story-bank.md` 存在，检查这些故事是否已入库，没有就追加。长期下来会形成 5-10 个 master story 可以应付各种行为面试题。

**按 track 选材：**

| track | 强调 |
|---|---|
| `ai-app` | Eval 闭环、效果迭代、成本控制、业务影响、从 demo 到生产的过程 |
| `ai-app-auto` | 同上 + **为什么想进汽车行业**（必被问）；把「物理世界约束 / 安全关键 / 成本敏感」讲成自己理解这个行业的证据，而不是泛泛说看好 |
| `auto-data` | 跨部门推动落地、数据质量闭环、从「数据可用」到「数据可训练」的思路迁移 |
| `auto-algo` | ⚠️ 不要装懂。主讲工程化那一面，并**主动点出自己在感知算法上的缺口和正在补的动作**（Block B2 的补齐计划就是答案）—— 面试官最反感的是硬撑 |
| `ai-data-bridge` | NL2SQL 的效果迭代、数据建模决策 |
| `ai-gov-bridge` | 跨部门推动、自上而下/自下而上的策略 |

⚠️ 技术面试三条铁律（见 memory `feedback_technical_interview_rules`）：①「没想过」要翻译成 tentative guess，不要直接认输 ②结尾必反问 1 个 ③面试前 24h 过一遍简历一致性（双 CV 之后这条更要紧 —— 确认自己讲的是哪一版）

**还要包含：**
- 1 个推荐主讲的 case study（哪个项目最适合主讲、怎么讲）
- 红线问题预演（如：「为什么从上一家离职？」「为什么频繁跳槽？」「能接受 996 吗？」「家庭情况能不能加班？」 — 这些国内 HR 真的会问，要准备好得体的应对话术）

---

## 评估后必做

### 1. 写 report .md

把完整评估写到 `reports/{###}-{company-slug}-{YYYY-MM-DD}.md`：
- `{###}` = 下一个序号（3 位补零）
- `{company-slug}` = 公司英文名小写、用连字符（中文公司可用拼音或常用英文，如 bytedance / alibaba / xiaohongshu）
- `{YYYY-MM-DD}` = 当前日期

**Report 模板：**

```markdown
# 评估：{公司} — {岗位}

**日期：** {YYYY-MM-DD}
**Archetype：** {检测到的}
**Track：** {ai-app | ai-app-auto | auto-data | auto-algo | ai-data-bridge | ai-gov-bridge}
**Tier：** {A1/A2/A3/B1/B2/B3/C1/C2/D/未明确}
**Score：** {X.X/5}
**URL：** {岗位原始 URL}
**PDF：** {路径或 pending}

---

## A) 角色摘要
（Block A 的完整内容）

## B) CV 匹配
（Block B 的完整内容）

## C) 级别与策略
（Block C 的完整内容）

## D) 薪酬与需求
（Block D 的完整内容）

## E) 个性化方案
（Block E 的完整内容）

## F) 面试准备
（Block F 的完整内容）

## G) Draft Application Answers
（仅当 score >= 4.5 — 申请表答案的草稿）

---

## 提取的关键词
（15-20 个 JD 关键词供 ATS 优化）
```

### 2. 写入 tracker

**永远** 写入 `data/applications.md` — 但是是通过 TSV 文件的方式（看 CLAUDE.md 中的 TSV 规范），由 `tools/merge-tracker.mjs` 自动合并。

字段：
- 序号
- 日期
- 公司
- 岗位
- Score（X.X/5）
- 状态：`Evaluated`（已评估）
- PDF：✅ 或 ❌
- Report：相对链接 `[NNN](reports/NNN-slug-date.md)`
- 备注（一句话总结）

> 注意：状态字段保持英文 canonical（`Evaluated`、`Applied` 等），因为 dashboard 和合并脚本依赖于此。Chinese 含义见 `templates/states.yml`。
