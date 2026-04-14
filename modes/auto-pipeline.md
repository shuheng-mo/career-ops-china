# Mode: auto-pipeline — 完整自动 Pipeline

候选人贴一个 JD（文本或 URL）但没指定子命令时，**按顺序自动跑完整 pipeline**。

## Step 0 — 提取 JD

**输入分类与处理（按推荐度排序）：**

### ✅ 优先级 1：JD 截图（图片附件）— **国内主路径**

如果用户拖了截图进来：**直接读图提取 JD**。Claude 多模态能力直接 OCR + 理解。

无任何反爬风险，覆盖 Boss / Mokahr / 飞书 / 微信 / 脉脉 等所有"看得到但抓不到"的场景。

### ✅ 优先级 2：JD 文本（粘贴）

直接用，不需要 fetch。

### ⚠️ 优先级 3：URL — 国内大概率失败

按下面顺序尝试，**但有铁律**：

1. **WebFetch 一次** — 公司自有静态 careers 页 / V2EX / GitHub README / 知乎文章 通常能拿到
2. **如果失败 / 拿到的是 SPA 壳 / 登录墙提示 → 立刻停止**

**🛑 国内门户白名单（看到就不要尝试自动化）：**

| 域名 | 行为 |
|------|------|
| `zhipin.com`（Boss直聘） | 直接告诉用户「Boss 反爬严，请截图」 |
| `liepin.com` 详情页 | 同上 |
| `lagou.com` 详情页 | 同上 |
| `maimai.cn` | 同上 |
| `mokahr.com` | 同上（DeepSeek 等独角兽 ATS） |
| `*.feishu.cn` 表单 | 同上（飞书招聘表单） |
| `mp.weixin.qq.com` | 试一次 WebFetch，失败立刻 yield |

**绝对不要：** 反复 retry / 切换 user-agent / 加 cookies / 启 Playwright headful 等"绕反爬"操作。**国内反爬团队比你专业，徒劳。**

### Yield 给用户的话术模板

WebFetch 失败时一次性说清楚：

```
这个 URL 抓不到（{原因：登录墙 / SPA 壳 / 反爬}）。
请用以下任一方式给我 JD：
1. 截图 JD 区域（Cmd+Shift+4）→ 拖到对话框
2. 复制 JD 全文 → 粘贴
然后我自动跑完整 pipeline。
```

不要重试，不要换工具。直接 yield，等用户输入。

## Step 1 — A-F 评估
完全按 `offer` mode 跑（读 `modes/offer.md` 的 A-F 六块）。

## Step 2 — 写 report .md
保存到 `reports/{###}-{company-slug}-{YYYY-MM-DD}.md`（格式见 `modes/offer.md`）。

## Step 3 — 生成 PDF
按 `modes/pdf.md` 跑完整 pipeline。

## Step 4 — Draft Application Answers（仅当 score >= 4.5）

如果最终 score >= 4.5，生成申请表答案的草稿：

1. **提取表单问题**：用 Playwright 打开申请表 + snapshot。如果取不到，用通用问题。
2. **生成回答**：按下面的 tone。
3. **存进 report**：作为 `## G) Draft Application Answers` 段落。

### 通用问题（取不到表单时用）

中国大陆常见问题：
- 为什么想加入我们？
- 为什么想做这个岗位？
- 你过往最有成就感的项目是什么？
- 你的优势和劣势是什么？
- 期望薪资？
- 能接受加班吗？最晚能到几点？
- 多久能到岗？
- 是否还有其他在谈的 offer？

英文外企/海外远程岗常见问题：
- Why are you interested in this role?
- Why do you want to work at [Company]?
- Tell us about a relevant project or achievement.
- What makes you a good fit for this position?
- How did you hear about this role?

### Form Answer 的 tone

**定位："我在选择你"** — 候选人有选择，是基于具体理由选择这家公司，不是来求职。

**Tone 规则：**
- **自信不傲慢**："过去一年我一直在搭建生产级的 RAG 系统 — 这个岗位正是我想把这套经验应用到下一个阶段的地方"
- **挑剔但不傲慢**："我在很认真地挑选下一份工作，希望加入一个我能从第一天就贡献价值的团队"
- **具体不空泛**：永远引用 JD 里真实存在的内容，和候选人经历里真实存在的事
- **直接没废话**：每个回答 2-4 句。禁用「我对...充满热情」「我希望有机会...」「我相信我能...」这类官腔
- **用证据 hook，不用宣告 hook**：不说"我擅长 X"，说"我做过 X，结果是 Y"

**按问题套框架：**
- **Why 这个岗位？** → "贵司的 [JD 中具体的事] 正好对应我之前做的 [我做过的具体事]"
- **Why 这家公司？** → 提一件公司具体的事。"我最近一直在用 [产品/技术] 做 [用途]"
- **过往项目？** → 一个量化的 proof point。"我在 X 项目里把 [指标] 从 A 提升到 B"
- **为什么是 fit？** → "我的经历正好在 [领域 A] 和 [领域 B] 的交叉点，这正是这个岗位需要的"
- **怎么知道这个岗位的？** → 老实说："朋友推荐 / 在 Boss 上看到 / 在公司技术博客上看到"

**国内特殊问题的处理：**
- **能接受加班/996？** → 不要直接拒绝也不要硬撑。"项目阶段需要冲刺我可以配合，但希望团队不是常态化加班，也希望大家用产出衡量价值。"
- **期望薪资？** → 给区间，不要给死数：「我的期望区间是 X-Y，弹性看 package 整体结构和发展空间」
- **多久到岗？** → 老实说，但留 buffer："我目前正在交接，最快 X 周，最晚 Y 周可以入职"
- **是否在谈其他 offer？** → 不要撒谎。"是的，目前还在 [N] 家流程中，希望最近 2-3 周内做决定"

**语言：** 默认中文。如果 JD 是英文（外企、海外远程），用英文。

## Step 5 — 更新 tracker
写入 `data/applications.md`（通过 TSV，见 CLAUDE.md），所有列填齐，包括 Report 和 PDF（✅）。

**如果某一步失败**，继续后面的步骤，把失败的步骤在 tracker 备注里标 pending。
