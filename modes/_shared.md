# 共享上下文 — career-ops（中国大陆版）

<!-- ============================================================
     ============================================================
     这是所有 career-ops mode 的共享上下文。
     本文件包含系统规则、评分逻辑和工具配置，会随每次 career-ops 发布而改进。不要把个人数据放在这里。
     你的个性化设置放在 modes/_profile.md（不会被自动更新）。
     
     使用前你必须：
     1. 在 config/profile.yml 填好个人数据
     2. 在项目根目录创建 cv.md
     3. cp modes/_profile.template.md modes/_profile.md，修改为你的 archetype、叙事、谈判偏好
     4. cp config/target_pool.template.md config/target_pool.md，修改为你的 Tier A/B/C/D 公司池
     5.（可选）创建 article-digest.md 写入你的 proof points
     ============================================================ -->

## 真理之源（评估前必读）

| 文件 | 路径 | 何时读 |
|------|------|------|
| cv.md | `cv.md`（项目根） | 总是 |
| article-digest.md | `article-digest.md`（如存在） | 总是（详细 proof points） |
| profile.yml | `config/profile.yml` | 总是（候选人身份与目标） |
| _profile.md | `modes/_profile.md` | 总是（候选人archetype、叙事、谈判偏好） |
| target_pool.md | `config/target_pool.md` | 总是（Tier A/B/C/D 公司池、画像反推规则） |

**规则：永远不要硬编码 proof points 的指标。** 评估时实时从 cv.md + article-digest.md 读。
**规则：当 cv.md 与 article-digest.md 不一致时，以 article-digest.md 为准**（cv.md 可能是旧数字）。
---

## 北极星 — 目标岗位（中国大陆）

> 见 `modes/_profile.md`。

所有评估必须先做 **Tier 检测**，Tier D 一律 SKIP。
> 详细可达池清单见 `config/target_pool.md`，deal_breakers 见 `config/profile.yml`。

### Tier 检测（评估前置规则，必须先于 Block A）

每个 JD 进 Block A 之前先做这一步：

1. **真实门槛硬筛**：JD 命中 `config/target_pool.md` 中 Tier D 触发关键词 → **立刻 SKIP**，不进 A-F

2. **Tier 归类**（写入 report 头）：
   - 对照 `config/target_pool.md` 中的 Tier A/B/C/D 归类
   - **未明确**：需查 `config/target_pool.md` 或 WebSearch 该公司画像

3. **画像反推规则**：评估"这家公司会不会真的给候选人面试机会"，不是"JD 写的能力候选人有没有"。
   - 候选人画像见 `config/target_pool.md`
   - JD 实际门槛 vs 画像差距 ≥ 1 档 → 降级或 SKIP

4. **Tier 处理**：
   - Tier A/B → 进 Block A-F 全评估
   - Tier C → 进 Block A-F 全评估；**综评 ≥ 4.0 才进投递候选，< 4.0 给 SKIP**
     （2026-10-08 起生效：Tier C 从"8 月底前延后"改为"按分数放行"，见 `config/target_pool.md` Tier C 段）
   - Tier D → SKIP，写一句"不在真实可达池"理由

---

## 薪酬情报（中国大陆市场）

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

> 见 `modes/_profile.md` 的 `## 谈判脚本`。

---

## 时间到 offer 优先级

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
1. 评估前先读 cv.md、article-digest.md（如存在）、`modes/_profile.md`
1b. **每个 session 第一次评估前：** 用 Bash 跑 `node tools/cv-sync-check.mjs`（或 `npm run sync-check`）。有 warning 先告诉候选人
2. 检测岗位 archetype 并自适应 framing（读 `modes/_profile.md`）
3. 匹配时引用 CV 的具体行
4. 用 WebSearch 查薪酬和公司数据（**优先中文源**）
5. 评估完一定写入 tracker
6. **生成内容默认用中文**。除非 JD 是英文（外企/海外远程/海外华人公司），才用英文
7. 直接、可执行 — 不要 fluff
8. 中文文案要符合中文工程师的说话方式：避免翻译腔，少用被动语态，多用动词。**技术术语保留英文**（LLM、Embedding、Pipeline、ATS、p99 等不要翻成中文）
8b. **PDF Professional Summary 里的案例 URL：** 如果 PDF 里提到案例/demo，URL 必须出现在第一段。HTML 中所有 URL 加 `white-space: nowrap`
9. **Tracker 新增用 TSV** — 永远不要直接编辑 applications.md 加新行。在 `batch/tracker-additions/` 写 TSV，由 `tools/merge-tracker.mjs` 合并
10. **每个 report 头都要有 `**URL:**`** — 在 Score 和 PDF 之间

### 工具

| 工具 | 用法 |
|------|------|
| WebSearch | 薪酬调研、趋势、公司文化、LinkedIn/脉脉 联系人、JD fallback |
| WebFetch | 静态页面 JD 提取 |
| Playwright | 验证岗位是否还在招（browser_navigate + browser_snapshot），SPA 上提取 JD。**关键：不要并行启动 2 个以上带 Playwright 的 agent — 它们共享一个浏览器实例。** 中国大陆门户（Boss直聘/拉勾/猎聘/智联）多数需要登录，Playwright 默认会被挡 — 见 `modes/scan.md` 的处理方式 |
| Read | cv.md, article-digest.md, _profile.md, target_pool.md, cv-template.html |
| Write | 临时 HTML for PDF, applications.md, reports .md |
| Edit | 更新 tracker |
| Bash | `node tools/generate-pdf.mjs`（或 `npm run pdf`） |
