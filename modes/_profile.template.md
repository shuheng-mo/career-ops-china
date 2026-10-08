# User Profile Context — career-ops（中国大陆版）

<!-- ============================================================
     这是你的文件。它永远不会被自动更新。
     
     在这里定制所有内容：archetype、叙事、
     proof points、谈判脚本等。
     ============================================================ -->

## 北极星 — 目标岗位（中国大陆）

<!-- 替换为你自己的目标岗位。 -->

### 核心 Archetypes

| Archetype | 主题轴 | 公司在为这个角色买什么 |
|-----------|--------|---------------------|
| **数据工程师 / Data Engineer**（primary）| NL2SQL、ChatBI、AI+数据 端到端落地、Pipeline、数据建模 | 能把数据 + LLM 落到业务的人（不是纯写 Spark/Flink 任务） |
| **大模型应用工程师 / LLM App**（primary）| RAG、Agent、Prompt 工程、Function Calling、Eval、Observability | 能把大模型落地到业务、保证质量、控制成本的人 |
| **数据治理 / Data Governance**（secondary，转 LLM 的 bridge）| 元数据、血缘、数据资产 + LLM 落地（银行金科常打包招）| 能让数据"用得起 + 管得住"，并在数据基础上做 AI 落地的人 |

### 已弃用 archetypes

<!-- 你明确放弃的方向。JD 命中这些且与 核心archetype 无强重叠 → Tier D → SKIP。 -->

以下方向**不再评估**（不在真实可达池 + 候选人主动放弃）：
- 数据仓库 / 数据平台 / DWH（纯数仓）
- 大数据算法 / 数据科学
- 后端工程师（即使带"数据/AI"修饰）
- AI Infra / 大模型基础设施（候选人画像打不进）
- 平台工程师 / 架构师

> 评估时若 JD 命中以上方向且**没有强 LLM 应用元素**，直接走 Tier D → SKIP。

### 按 Archetype 自适应包装

<!-- 把你的项目映射到每个 archetype。 -->

> **具体指标：评估时从 `cv.md` + `article-digest.md` 读取。NEVER 在这里硬编码数字。**

| 如果岗位是… | 强调候选人身上的… | proof points 来源 |
|------------|------------------|------------------|
| 数据工程师 | NL2SQL/ChatBI 端到端、数据治理 + LLM、[你的相关项目 + 量化成果] | article-digest.md + cv.md |
| 数据治理（带 LLM）| 元数据/血缘 + NL2SQL 闭环、跨部门推动、数据资产 → LLM 落地 | article-digest.md + cv.md |
| 大模型应用工程师 | 端到端 RAG/Agent、Eval（173/173 tests + 14 case 量化）、Observability、多模型路由、SELECT-only 安全 | cv.md + article-digest.md |

<!-- 把你具体的项目映射到上面 3 个 archetype。已弃用的方向（数仓/大数据/后端/AI Infra/平台）不在此表。 -->

### 个人叙事 / Exit Narrative（在所有 framing 中复用）

<!-- 替换为你自己的叙事。这是所有内容的框架。
     示例：
     - "5 年大厂数据开发经验，独立从 0 搭建过日均百亿级数仓"
     - "数据工程转大模型应用，最近一年 RAG/Agent 系统已上生产"
     - "稳定性和成本是我的强项，过去两年帮团队把数仓查询提速 5 倍" -->

从 `config/profile.yml` 的 `narrative.exit_story` 读取候选人的叙事，在以下场景使用：
- **PDF Summary**：用一句话桥接过去与未来 — "把同样的[能力]迁移到[JD 领域]"
- **STAR 故事**：引用 article-digest.md 中的 proof points
- **应用表格答案（Section G）**：转型叙事在第一题就要出现
- **当 JD 提到 "ownership / 自驱 / 全栈 / 端到端 / 从 0 到 1"**：这是 #1 加分项，提高匹配权重

### 横向优势

<!-- 你的"独门武器"是什么？用复合信号定位自己，而不是技能清单。 -->

把候选人定位成 **"能落地的技术构建者"（builder with real-world proof）**，按角色调整说法：
- 对大模型应用：「能把模型从 demo 推到生产、有 Eval/Observability 闭环的工程师」
- 对数据工程：「既懂业务建模又能写性能稳定的 Spark/Flink 任务的工程师」
- 对数据治理：「能跨部门推动落地、不只是写文档的治理人」
- 对平台架构：「自己搭过中台/平台、知道用户痛点的架构师」

把"会写代码 + 能上线 + 有数据"打包成一种专业信号，而不是"个人爱好型 maker"。

### Portfolio / 作品集 作为 proof point

<!-- 如果你有 live demo、dashboard 或公开项目：
     dashboard:
       url: "https://your-blog.dev"
       password: ""
       when_to_share: "大模型应用、数据平台岗" -->

如果候选人有 live demo 或 GitHub 项目（在 profile.yml 检查），在相关岗位申请时主动给出链接。

## 谈判脚本

<!-- 按你的情况调整。中文职场语境。 -->

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

## 工作地点 / 远程政策

<!-- 按你的情况调整。中文城市语境。从 config/profile.yml → location 读取。 -->

**填表时：**
- "你能否到 [城市] on-site 工作？" 这种问题：按 profile.yml 里你的实际意愿回答
- 自由文本框里：写清楚你接受的城市、是否能搬迁、是否接受出差比例

**评估打分时：**
- 国内大厂基本都是 5 天 onsite，**远程评分维度应当务实**：full remote 给 5 分基本没机会
- onsite 在你 base 城市：5 分
- onsite 在你愿意搬迁的城市：3-4 分
- onsite 在你不愿去的城市：1-2 分
- 混合（一周 X 天）：按比例评
