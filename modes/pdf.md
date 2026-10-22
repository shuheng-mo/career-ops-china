# Mode: pdf — ATS 优化 PDF 生成

## 完整 pipeline

0. **先定 track，再选 CV 源**（见 `modes/_profile.md` 的「CV 选源（按 track）」表）：
   - `ai-app` / `ai-data-bridge` / `ai-gov-bridge` → `cv.md`
   - `ai-app-auto` / `auto-data` / `auto-algo` → `cv-auto.md`；**缺失则回落 `cv.md`，并在交付说明里写明回落**
   - 上下文里没有 track（用户直接丢一份 JD 过来）→ 按 `modes/_shared.md` 的 Step 0 先判一次
1. 读上一步选中的 CV 文件作为**事实层真理之源**
   - ⚠️ `cv.md` 是 canonical；变体只允许改写措辞/取舍重排，**不能有 `cv.md` 里不存在的雇主、日期、学历或数字**
   - 生成前跑一次 `npm run sync-check`。它**会以非零退出**拦住事实注入 —— 国内背调查得到，两份自相矛盾的简历是最糟的失败方式
2. 如果上下文里没有 JD，向用户索取（文本或 URL）
3. 从 JD 提取 15-20 个关键词
4. 检测 JD 语言 → 决定 CV 语言
   - 中文 JD → 中文 CV
   - 英文 JD → 英文 CV
   - 双语 JD → 中文优先
5. 检测公司所在地 → 决定纸张：
   - 中国大陆 / 港澳台 / 大多数国家 → `a4`
   - 美国/加拿大 → `letter`
6. 检测 archetype → 适配 framing
7. 重写 Professional Summary：注入 JD 关键词 + exit narrative bridge（"过去 N 年在 X，现在把同样的能力带到 [JD 领域]"）
8. 选 top 3-4 个最相关的项目
9. 按 JD 相关性重新排序工作经历的 bullets
10. 构建 competency grid（6-8 个关键词短语）
11. 把关键词自然注入到现有成就描述中（**永远不要编造新技能**）
12. 按下方「Markdown 格式」写定制简历，存为 `output/cv-candidate-{company}-{track}-{YYYY-MM-DD}.md`
    - **文件名带 track 后缀**（如 `-ai-app` / `-auto-data`）。同一家车企可能两个方向都投，没有后缀就会互相覆盖，而且事后分不清「这家投的是哪版简历」
13. 执行：`npm run cv -- output/cv-candidate-{company}-{track}-{YYYY-MM-DD}.md [--format=letter]`，PDF 生成在 md 旁边、同名
    - 脚本会在正文出现箭头时**直接失败**，按报错改成中文句子再跑
14. 报告：md 与 PDF 路径、页数、关键词覆盖率、**用的哪个 CV 源**（回落了就明说）

> **md 是定制简历的唯一源文件**（2026-10-11 起）。候选人自己改小地方就是改 md 再跑一次 `npm run cv`，不要再生成 HTML 让人手改。
> 旧的 `templates/cv-template.html` + `tools/generate-pdf.mjs` 只保留给历史文件，新简历不要用。

## ATS 规则（保证机器能解析）

- 单栏布局（不要 sidebar、不要平行栏）
- 标准 section 标题：「专业摘要 / Professional Summary」「工作经历 / Work Experience」「教育 / Education」「技能 / Skills」「证书 / Certifications」「项目经历 / Projects」
- 不要在图/SVG 里放文字
- 不要把关键信息放 PDF header/footer（ATS 一般忽略）
- UTF-8、文本可选中（不能是栅格化的图）
- 不要嵌套表格
- 关键词在 Summary（top 5）、每个工作经历的第一个 bullet、Skills section 里都要出现

## 中国大陆 CV 的额外约定

- **学历放在显著位置** — 国内 HR 第一眼就会找学校
- **个人信息**：姓名、电话、邮箱、所在城市、（可选）证件照
  - 互联网大厂一般不要照片
  - 国企/外企 / 偏 ToB 的公司常见放照片
- **是否写出生年月**：默认不写。如果是国企/外企可加。35 岁以上的候选人不建议写
- **工作经历描述模式**：依次交代业务背景、我的角色、技术方案和量化结果
- ⛔ **硬性规则（候选人 2026-10-11 明确要求，不得再改回）：**
  1. **全部文字一律纯黑 `#000`**。标题、公司名、项目名、标签、链接、日期都不例外；不用彩色、不用灰字、不用彩色底纹或渐变线。
  2. **正文禁止用箭头串流程**（`A → B → C`、`57s → 10s`、`ODS→DWS` 都不行）。改写成通顺的中文句子，例如「依次完成意图识别、Schema 召回、SQL 生成和自修正」「端到端延迟从 57 秒降到 10 秒」「ODS、DWD、DWS 三层数仓」。
  3. **页眉只放联系方式，第一项必须是手机号**（手机、邮箱、GitHub 主页、个人网站、所在城市与到岗时间；手机号从 `cv.md` 读）。没有手机号 HR 就联系不到人 —— 2026-10-22 发现 57 份定制简历全漏了手机号，`tools/cv-md-to-pdf.mjs` 现在会在页眉缺手机号时直接构建失败。个人项目的链接只出现在对应项目段落里，不进页眉，也不进摘要。
  4. **Section 标题用标准名称**：「项目经历」「工作经历」等，不加「（Agent Demo）」这类括号后缀；摘要里也不要写「两个可直接体验的 Demo」这种推销腔。
  颜色由 `tools/cv-md-to-pdf.mjs` 的样式表保证（只有 `#000`），箭头由它在构建时拦截。
- **量化结果**：QPS、p99、SLA、降本百分比、用户量、AB 实验提升 — 越具体越好
- **技术栈**：用国内通用术语（如「数据中台」「数仓分层 ODS/DWD/DWS/ADS」「Doris/StarRocks」），不要硬翻译

## PDF 设计

- **字体**：Space Grotesk（标题，600-700）+ DM Sans（正文，400-500）+ 中文字体 fallback（PingFang SC / Microsoft YaHei / Noto Sans SC）
- **字体自托管**：`fonts/`
- **Header**：姓名 + 联系信息行 + 纯黑分隔线
- **Section 标题**：Space Grotesk 13px，uppercase（中文 section 不 uppercase），letter-spacing 0.05em，纯黑
- **正文**：DM Sans 11px（中文用对应 fallback），行高 1.5，纯黑
- **公司名 / 项目名**：纯黑，用字重区分层级，不用颜色
- **页边距**：0.6in
- **背景**：纯白

## Section 顺序（"6 秒 HR 扫描"优化）

1. Header（姓名、联系方式、所在城市；不放项目链接）
2. Professional Summary / 专业摘要（3-4 行，关键词密集）
3. Core Competencies / 核心能力（6-8 个关键词短语，一行用 ` · ` 分隔）
4. Work Experience / 工作经历（倒序）
5. Projects / 项目经历（top 3-4）
6. Education / 教育 & Certifications / 证书
7. Skills / 技能（语言 + 技术）

## 关键词注入策略（基于事实，不编造）

合理改写示例：
- JD 说 "数据湖仓一体" 而 CV 写 "Iceberg + Spark + 数据中台" → 改成 "数据湖仓一体方案：基于 Iceberg + Spark 构建统一存储查询层"
- JD 说 "RAG pipeline" 而 CV 写 "向量检索 + LLM 流程" → 改成 "RAG pipeline 设计：向量检索 + LLM 编排"
- JD 说 "MLOps" 而 CV 写 "训练监控 + 上线流程" → 改成 "MLOps 实践：训练监控、模型上线流水线、效果观测"

**绝不添加候选人没有的技能。只用 JD 的精确措辞重写真实经历。**

## Markdown 格式

样式全部由 `tools/cv-md-to-pdf.mjs` 决定，md 里只写内容。

```markdown
# 姓名

邮箱 · github.com/xxx · 个人网站

现居城市 · 到岗时间

## 专业摘要

一段话。

## 核心能力

关键词一 · 关键词二 · 关键词三

## 项目经历

### 项目名 — 一句话定位（个人开源）　2025.08 – 至今

- **小标题：** 一句完整的中文描述，数字用 **加粗**。

技术栈：A、B、C。仓库：github.com/xxx/yyy

## 工作经历

### 公司 — 部门 · 职位　2023.03 – 2024.08

- **小标题：** ……
```

约定：
- `#` 和第一个 `##` 之间的段落自动成为页眉联系信息（小字 + 分隔线）
- `###` 以日期区间结尾（`2023.03 – 2024.08` / `2025.08 – 至今`）时，日期自动右对齐
- 链接直接写纯文本（`github.com/xxx`），不要用 `[文字](url)`，ATS 读的是可见文字

## 生成后

如果这个岗位已经在 tracker 里：把 PDF 列从 ❌ 改成 ✅。
