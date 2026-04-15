# Mode: offer — 单岗位完整评估（A-F 六块）

候选人贴一个职位（文本或 URL）时，**必须按顺序输出 A-F 六个 block**。

## Step 0 — Archetype 检测

把这个岗位归类到 `_shared.md` 中定义的 8 个 archetype 之一：
- 数据工程师 / Data Engineer
- 数据仓库 / 数据平台 / DWH
- 数据治理 / Data Governance
- 大模型应用工程师 / LLM Engineer
- AI Infra / 大模型基础设施
- 后端工程师（数据/AI 方向）
- 平台工程师 / 架构师
- 大数据算法 / 数据科学

如果是混合型，标出最接近的 2 个。Archetype 决定：
- Block B 优先突出哪些 proof points
- Block E 怎么改写 summary
- Block F 准备哪种 STAR 故事

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

读 `cv.md`。建一张表：JD 的每条要求 → 候选人 CV 中的具体行。

**按 archetype 调整优先级：**
- 数据工程 → 优先：管道吞吐、调度系统、Spark/Flink/Kafka、SLA、降本案例
- 数据仓库/平台 → 优先：分层规范、维度建模、查询提速、湖仓技术（Iceberg/Hudi/Paimon）、引擎选型（Doris/StarRocks/CK）
- 数据治理 → 优先：元数据/血缘/质量平台、跨部门推动、主数据、合规、数据资产
- 大模型应用 → 优先：RAG/Agent 架构、Eval 体系、Prompt 工程、向量检索、上线效果
- AI Infra → 优先：训推性能、显存优化、vLLM/SGLang、GPU 调度、模型服务化
- 后端 → 优先：QPS、可用性、p99、复杂业务建模、重构案例
- 平台/架构 → 优先：内部用户数、效能数据、SLO、平台演进
- 大数据算法 → 优先：业务指标提升、AB 实验、特征工程

输出一个 **gaps 段落**，对每个 gap 给出缓解策略：
1. 是 hard blocker 还是 nice-to-have？
2. 候选人能否用相邻经验论证？
3. 有没有作品集/GitHub 项目能填补这个 gap？
4. 具体的缓解动作（cover letter 的一句话 / 一个快速 side project / 引用某个开源贡献等）

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

**按 archetype 选材：**
- 数据工程 → 强调链路稳定性、数据质量、降本提效的具体数字
- 数据仓库 → 强调建模决策、迭代取舍、查询提速对业务的影响
- 数据治理 → 强调跨部门推动、自上而下/自下而上的策略
- 大模型应用 → 强调 Eval 闭环、效果迭代、成本控制、业务影响
- AI Infra → 强调性能数字、稳定性事故复盘、降本
- 后端 → 强调高并发、可用性、复杂业务抽象
- 平台/架构 → 强调内部用户数、采纳率、平台演进决策
- 算法 → 强调 AB 实验设计、业务指标提升

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
