# 共享上下文 — career-ops（中国大陆版）

<!-- ============================================================
     如何定制
     ============================================================
     这是所有 career-ops mode 的共享上下文。
     使用前你必须：
     1. 在 config/profile.yml 填好个人数据
     2. 在项目根目录创建 cv.md
     3.（可选）创建 article-digest.md 写入你的 proof points
     4. 修改下面带 [CUSTOMIZE] 标记的部分
     ============================================================ -->

## 真理之源（评估前必读）

| 文件 | 路径 | 何时读 |
|------|------|------|
| cv.md | `cv.md`（项目根） | 总是 |
| article-digest.md | `article-digest.md`（如存在） | 总是（详细 proof points） |
| profile.yml | `config/profile.yml` | 总是（候选人身份与目标） |

**规则：永远不要硬编码 proof points 的指标。** 评估时实时从 cv.md + article-digest.md 读。
**规则：当 cv.md 与 article-digest.md 不一致时，以 article-digest.md 为准**（cv.md 可能是旧数字）。

---

## 北极星 — 目标岗位（中国大陆 · 数据/AI/平台方向）

技能对所有目标岗位用同等严谨度评估。**没有主次之分** — 任何一个岗位只要 comp 与发展空间合适都算成功。

| Archetype | 主题轴 | 公司在为这个角色买什么 |
|-----------|--------|---------------------|
| **数据工程师 / Data Engineer** | ETL/ELT、数据管道、数据建模、Spark/Flink、调度（DolphinScheduler/Airflow） | 能把分散数据稳定可靠地汇总进数仓的人 |
| **数据仓库 / 数据平台 / DWH** | 数据分层（ODS/DWD/DWS/ADS）、维度建模、数据湖仓一体（Iceberg/Hudi/Paimon）、Doris/StarRocks/ClickHouse | 能从 0 到 1 或迭代企业级数仓的架构者 |
| **数据治理 / Data Governance** | 元数据、血缘、数据质量、主数据、安全合规、数据资产、数据中台 | 能让数据"用得起、管得住、信得过"的人 |
| **大模型应用工程师 / LLM Engineer** | RAG、Agent、Prompt 工程、Function Calling、向量检索、Eval、Observability | 能把大模型落地到业务并保证质量的人 |
| **AI Infra / 大模型基础设施** | 训推一体、显存优化、vLLM/SGLang、分布式训练、模型服务化、GPU 调度 | 能让大模型跑得快、稳、便宜的人 |
| **后端工程师（数据/AI 方向）** | Java/Go/Python、微服务、中间件、高并发、分布式存储、消息队列 | 业务后端能力扎实、能配合数据/AI 团队的工程师 |
| **平台工程师 / 架构师** | 内部平台、DevOps/MLOps、可观测、CI/CD、稳定性、SRE | 能把工程组织的"地基"做好的人 |
| **大数据算法 / 数据科学（业务侧）** | 用户画像、推荐、风控、AB 实验、特征工程、因果推断 | 能用数据驱动业务决策并落地模型的人 |

<!-- [CUSTOMIZE] 上面这 8 个 archetype 是为「数据工程 + 大模型 + 后端 + 平台」的求职者优化的。
     如果你的主攻方向变了，直接告诉 Claude 改这一段即可。 -->

### 按 Archetype 自适应包装

> **具体指标：评估时从 `cv.md` + `article-digest.md` 读取。NEVER 在这里硬编码数字。**

| 如果岗位是… | 强调候选人身上的… | proof points 来源 |
|------------|------------------|------------------|
| 数据工程师 | 大规模数据吞吐、稳定性、SLA、链路重构经验、降本 | article-digest.md + cv.md |
| 数据仓库/平台 | 分层规范从 0 到 1、模型迭代、查询提速、存储成本下降 | article-digest.md + cv.md |
| 数据治理 | 元数据/血缘/质量平台从 0 到 1、跨部门推动、合规落地 | article-digest.md + cv.md |
| 大模型应用工程师 | 端到端 RAG/Agent 落地、Eval 体系、效果提升、用户量 | cv.md + article-digest.md |
| AI Infra | 训推性能、GPU 利用率、推理成本/延迟、稳定性 | article-digest.md + cv.md |
| 后端工程师 | QPS、可用性、p99 延迟、复杂业务建模、重构经验 | cv.md + article-digest.md |
| 平台工程师/架构师 | 提效数据、内部用户数、稳定性 SLO、平台演进 | cv.md + article-digest.md |
| 大数据算法 | 业务指标提升、AB 实验设计、模型上线后效果 | cv.md + article-digest.md |

<!-- [CUSTOMIZE] 把你具体的项目映射到上面每个 archetype -->

### 个人叙事 / Exit Narrative（在所有 framing 中复用）

<!-- [CUSTOMIZE] 替换为你自己的叙事。示例：
     - "5 年大厂数据开发经验，独立从 0 搭建过日均百亿级数仓"
     - "数据工程转大模型应用，最近一年 RAG/Agent 系统已上生产"
     - "稳定性和成本是我的强项，过去两年帮团队把数仓查询提速 5 倍" -->

从 `config/profile.yml` 的 `narrative.exit_story` 读取候选人的叙事，在以下场景使用：
- **PDF Summary**：用一句话桥接过去与未来 — "把同样的[能力]迁移到[JD 领域]"
- **STAR 故事**：引用 article-digest.md 中的 proof points
- **应用表格答案（Section G）**：转型叙事在第一题就要出现
- **当 JD 提到 "ownership / 自驱 / 全栈 / 端到端 / 从 0 到 1"**：这是 #1 加分项，提高匹配权重

### 横向优势

把候选人定位成 **"能落地的技术构建者"（builder with real-world proof）**，按角色调整说法：
- 对大模型应用：「能把模型从 demo 推到生产、有 Eval/Observability 闭环的工程师」
- 对数据工程：「既懂业务建模又能写性能稳定的 Spark/Flink 任务的工程师」
- 对数据治理：「能跨部门推动落地、不只是写文档的治理人」
- 对平台架构：「自己搭过中台/平台、知道用户痛点的架构师」

把"会写代码 + 能上线 + 有数据"打包成一种专业信号，而不是"个人爱好型 maker"。

### Portfolio / 作品集 作为 proof point

<!-- [CUSTOMIZE] 如果有 live demo / GitHub 项目 / 个人博客 / 知乎专栏，在 profile.yml 配置：
     dashboard:
       url: "https://your-blog.dev"
       password: ""
       when_to_share: "大模型应用、数据平台岗" -->

如果候选人有 live demo 或 GitHub 项目（在 profile.yml 检查），在相关岗位申请时主动给出链接。

### 薪酬情报（中国大陆市场）

<!-- [CUSTOMIZE] 调研你目标岗位的薪资段并更新这里 -->

**通用指引：**
- 用 WebSearch 查最新市场数据，**优先使用以下中文数据源**：
  - **看准网（kanzhun.com / kanzhun.com/salary）** — Boss直聘旗下，国内最全的薪酬/口碑站，相当于国内 Glassdoor
  - **脉脉（maimai.cn）** — 匿名职言区有大量真实薪酬讨论，搜 "公司名 薪资" 或 "公司名 P7"
  - **OfferShow（offershow.cn）** — offer 对比平台，按公司/职级筛选
  - **知乎** — 搜 "如何评价 X 公司" / "X 公司 P7 薪资" / "X 公司加班"
  - **一亩三分地（1point3acres.com）** — 国内版块有中国大厂讨论
  - **leetcode.cn 招聘版** — 应届/社招薪酬讨论
  - **互联网公司职级对标表**（搜 "互联网职级对标" Excel/Sheets 截图）
- **不要用** Glassdoor / Levels.fyi / Blind 来查中国公司，数据基本是空的
- 按职级（P/T/L 体系）查，不按 skill 查 — 职级决定薪酬带
- **主动了解大小周/996 现状**，写进 Block D
- 远程岗在国内极少，谨慎评分

**互联网大厂职级对标参考**（仅供 archetype 检测时反推 seniority）：
| 阿里 | 字节 | 腾讯 | 美团 | 京东 | 快手 | 大致经验 |
|------|------|------|------|------|------|---------|
| P5 | 1-1 / 1-2 | T1 | L6 | P5 | 2-1 | 0-2 年 |
| P6 | 2-1 / 2-2 | T2.1-T2.2 | L7 | P6 | 2-2 | 2-5 年 |
| P7 | 3-1 / 3-2 | T2.3-T3.1 | L8 | P7 | 2-3 | 5-8 年 |
| P8 | 3-2 / 4-1 | T3.2-T3.3 | L9 | P8 | 3-1 | 8-12 年 |
| P9 | 4-1 / 4-2 | T4 | L10+ | P9 | 3-2 | 12+ 年 |

> 这只是参考，实际级别会因业务线、入职年份不同有差异。**评估时不要硬套**，让候选人自己确认。

### 谈判脚本

<!-- [CUSTOMIZE] 按你的情况调整 -->

**薪资期望（通用框架）：**
> "结合市场行情和这个岗位的要求，我的期望是 [profile.yml 中的范围]。结构上可以谈，关键看 total package 和发展空间。"

**HR 拿"对标我们司 P6"压价：**
> "职级 title 我可以接受弹性，但 package 我会按实际能力和市场对标。能否说一下贵司 P6 的薪资带宽？"

**地理折扣（一线 vs 二线）：**
> "这个岗位的产出不是按城市分的，我过去的项目交付质量也不会因为 base 在 X 城而变化。"

**低于预期：**
> "我目前在和 [更高范围] 的几家公司谈，选择贵司是因为 [具体原因]。能否在 [目标数字] 这边再 align 一下？"

**反 996 / 大小周提问（如果你介意）：**
> "我希望能可持续地长期产出。咱们团队的真实工时大概是怎样？周末是 on-call 还是常规要来？"

### 工作地点 / 远程政策

<!-- [CUSTOMIZE] 按你的情况调整。从 config/profile.yml → location 读取 -->

**填表时：**
- "你能否到 [城市] on-site 工作？" 这种问题：按 profile.yml 里你的实际意愿回答
- 自由文本框里：写清楚你接受的城市、是否能搬迁、是否接受出差比例

**评估打分时：**
- 国内大厂基本都是 5 天 onsite，**远程评分维度应当务实**：full remote 给 5 分基本没机会
- onsite 在你 base 城市：5 分
- onsite 在你愿意搬迁的城市：3-4 分
- onsite 在你不愿去的城市：1-2 分
- 混合（一周 X 天）：按比例评

### 时间到 offer 优先级
- 真实可演示的 demo + 数据 > 完美
- 早投 > 学更多
- 80/20 原则，所有事都 timebox

---

## 全局规则

### 永远不要

1. 编造经历或指标
2. 修改 cv.md 或作品集文件
3. 替候选人提交申请
4. 在生成的消息里写出手机号
5. 推荐低于市场的薪酬
6. 不读 JD 就生成 PDF
7. 用官腔/PR 话术
8. 忽略 tracker（每个评估过的岗位都要入库）

### 永远要

0. **求职信 / Cover Letter：** 表单里如果有 cover letter 字段就一定要写一份。生成 PDF 用同一套设计。内容：JD 关键句 → 对应 proof points → 相关案例链接。1 页内。
1. 评估前先读 cv.md 和 article-digest.md（如存在）
1b. **每个 session 第一次评估前：** 用 Bash 跑 `node cv-sync-check.mjs`。有 warning 先告诉候选人
2. 检测岗位 archetype 并自适应 framing
3. 匹配时引用 CV 的具体行
4. 用 WebSearch 查薪酬和公司数据（**优先中文源**）
5. 评估完一定写入 tracker
6. **生成内容默认用中文**。除非 JD 是英文（外企/海外远程/海外华人公司），才用英文
7. 直接、可执行 — 不要 fluff
8. 中文文案要符合中文工程师的说话方式：避免翻译腔，少用被动语态，多用动词。**技术术语保留英文**（LLM、Embedding、Pipeline、ATS、p99 等不要翻成中文）
8b. **PDF Professional Summary 里的案例 URL：** 如果 PDF 里提到案例/demo，URL 必须出现在第一段。HTML 中所有 URL 加 `white-space: nowrap`
9. **Tracker 新增用 TSV** — 永远不要直接编辑 applications.md 加新行。在 `batch/tracker-additions/` 写 TSV，由 `merge-tracker.mjs` 合并
10. **每个 report 头都要有 `**URL:**`** — 在 Score 和 PDF 之间

### 工具

| 工具 | 用法 |
|------|------|
| WebSearch | 薪酬调研、趋势、公司文化、LinkedIn/脉脉 联系人、JD fallback |
| WebFetch | 静态页面 JD 提取 |
| Playwright | 验证岗位是否还在招（browser_navigate + browser_snapshot），SPA 上提取 JD。**关键：不要并行启动 2 个以上带 Playwright 的 agent — 它们共享一个浏览器实例。** 中国大陆门户（Boss直聘/拉勾/猎聘/智联）多数需要登录，Playwright 默认会被挡 — 见 `modes/scan.md` 的处理方式 |
| Read | cv.md, article-digest.md, cv-template.html |
| Write | 临时 HTML for PDF, applications.md, reports .md |
| Edit | 更新 tracker |
| Bash | `node generate-pdf.mjs` |
