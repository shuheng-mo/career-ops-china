---
name: career-ops
description: 中国大陆 AI 求职指挥中心 — 评估岗位、生成定制简历、扫描门户、追踪申请
user_invocable: true
args: mode
---

# career-ops — Router（中国大陆版）

## Mode Routing

根据 `{{mode}}` 决定模式：

| 输入 | Mode |
|------|------|
| (空 / 无参数) | `discovery` — 显示命令菜单 |
| **JD 截图（图片附件）** | **`auto-pipeline`**（推荐主路径，国内 Boss/Mokahr 等反爬平台必用） |
| JD 文本（粘贴）| **`auto-pipeline`** |
| 岗位 URL（无子命令） | `auto-pipeline` — 但**国内 URL 90% 抓不到 JD**，会让用户截图 |
| `offer` | `offer`（单岗位评估 A-F） |
| `offers` | `offers`（多 offer 对比） |
| `contact` | `contact`（脉脉/微信/LinkedIn 触达） |
| `deep` | `deep`（公司调研 prompt） |
| `pdf` | `pdf`（生成定制 PDF） |
| `training` | `training`（评估课程/证书） |
| `project` | `project`（评估 portfolio 项目） |
| `tracker` | `tracker`（查看申请状态） |
| `pipeline` | `pipeline`（处理待办 URL inbox） |
| `apply` | `apply`（实时表单填写助手） |
| `scan` | `scan`（**线索发现**，仅 URL+标题，不取 JD） |
| `inbox` | `inbox`（处理 bookmarklet 捕获的 JD 文件，自动评估）|
| `story-sync` | `story-sync`（扫 reports/* 抽取 Block F，累积到 story-bank.md）|
| `batch` | `batch`（批量处理） |

**Auto-pipeline 检测：** 如果 `{{mode}}` 不是已知子命令但包含：
- JD 文本（出现关键词："岗位职责"、"任职要求"、"工作描述"、"responsibilities"、"requirements"、公司名 + 岗位名）
- 图片附件（截图）
- 岗位 URL

→ 执行 `auto-pipeline`。

如果 `{{mode}}` 既不是子命令也不像 JD，显示 discovery。

**🇨🇳 中国大陆使用规则：**
> 如果用户给的是国内招聘门户 URL（zhipin.com / liepin.com / lagou.com / mokahr.com / feishu.cn 等），先尝试 WebFetch 一次，**失败就立刻停止自动化尝试**，让用户截图给你。**不要在反爬上反复挣扎**。

---

## Discovery Mode（无参数时）

显示这个菜单：

```
career-ops — 中国大陆求职指挥中心

🎯 主路径（90% 时间用这个）：
  截图 JD → 拖到对话框 → /career-ops（自动 auto-pipeline）
    或
  复制 JD 全文 → 粘贴 → /career-ops（自动 auto-pipeline）
    
  ✅ 5 秒/岗位，零反爬风险，覆盖 Boss/Mokahr/飞书/微信/脉脉 全平台
  ✅ Claude 直接读图，自动评估 + report + PDF + tracker 一条龙

⚠️ 国内 URL 默认抓不到 JD（Boss/拉勾/猎聘/Mokahr/飞书都是反爬+登录墙）
  贴 URL 给我也行，但我会很快让你截图。**截图永远更快**。

⚡ 高效路径（用浏览器 bookmarklet）：
  打开 JD 页（Boss/猎聘/Mokahr/大厂 careers 都行）→ 点 bookmarklet
  → JSON 自动落到 inbox/ → 跑 /career-ops inbox 批量处理
  
  首次安装：tools/README.md（启动本地服务 + 拖按钮到书签栏）

辅助命令：
  /career-ops scan     → 线索发现（仅 URL+标题，不取 JD），之后用截图取 JD
  /career-ops inbox    → 处理 bookmarklet 抓的 JD 文件，自动评估全部
  /career-ops offer    → 单岗位 A-F 完整评估（不自动生成 PDF）
  /career-ops offers   → 多 offer 对比 + 加权评分
  /career-ops pdf      → 单独生成 ATS 优化的定制简历 PDF
  /career-ops pipeline → 批处理 pipeline.md 里的待办 URL
  /career-ops batch    → 批量并行评估多个岗位
  /career-ops tracker  → 查看申请状态汇总

  /career-ops contact  → 主动触达：脉脉/微信/LinkedIn 消息草稿
  /career-ops deep     → 生成公司深度调研 prompt（中文数据源）
  /career-ops apply    → 实时申请表助手（读屏幕 + 生成回答）

  /career-ops training → 评估课程/证书是否值得学
  /career-ops project  → 评估 portfolio 项目的 ROI
  /career-ops story-sync → 扫 reports/* 抽 Block F 累积到 story-bank.md

🔁 推荐工作流：
  1. /career-ops scan       → 发现一批感兴趣的公司/岗位（URL + 标题）
  2. 对每个感兴趣的：截图 JD → 拖给我 → 自动评估
  3. 拿到 offer → 改 tracker 状态（直接告诉我即可）
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

### Modes that require `_shared.md` + their mode file:
Read `modes/_shared.md` + `modes/{mode}.md`

Applies to: `auto-pipeline`, `offer`, `offers`, `pdf`, `contact`, `apply`, `pipeline`, `scan`, `inbox`, `batch`

### Standalone modes (only their mode file):
Read `modes/{mode}.md`

Applies to: `tracker`, `deep`, `training`, `project`, `story-sync`

### Modes delegated to subagent:
For `scan`, `apply` (with Playwright), and `pipeline` (3+ URLs): launch as Agent with the content of `_shared.md` + `modes/{mode}.md` injected into the subagent prompt.

```
Agent(
  subagent_type="general-purpose",
  prompt="[content of modes/_shared.md]\n\n[content of modes/{mode}.md]\n\n[invocation-specific data]",
  description="career-ops {mode}"
)
```

Execute the instructions from the loaded mode file.
