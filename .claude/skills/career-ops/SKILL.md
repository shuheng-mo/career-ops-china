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
| JD 文本或 URL（无子命令） | **`auto-pipeline`** |
| `oferta` | `oferta`（单岗位评估 A-F） |
| `ofertas` | `ofertas`（多 offer 对比） |
| `contacto` | `contacto`（脉脉/微信/LinkedIn 触达） |
| `deep` | `deep`（公司调研 prompt） |
| `pdf` | `pdf`（生成定制 PDF） |
| `training` | `training`（评估课程/证书） |
| `project` | `project`（评估 portfolio 项目） |
| `tracker` | `tracker`（查看申请状态） |
| `pipeline` | `pipeline`（处理待办 URL inbox） |
| `apply` | `apply`（实时表单填写助手） |
| `scan` | `scan`（扫描门户找新岗位） |
| `batch` | `batch`（批量处理） |

> 注：mode identifier（oferta / ofertas / contacto 等）保留西班牙语词源，
> 因为它们对应 `modes/{name}.md` 的文件名。重命名会涉及大量跨文件引用更新，
> 留作未来独立 commit。日常使用时记住中文意思即可。

**Auto-pipeline 检测：** 如果 `{{mode}}` 不是已知子命令但包含 JD 文本（出现关键词：
"岗位职责"、"任职要求"、"工作描述"、"responsibilities"、"requirements"、公司名 + 岗位名）
或是岗位 URL，执行 `auto-pipeline`。

如果 `{{mode}}` 既不是子命令也不像 JD，显示 discovery。

---

## Discovery Mode（无参数时）

显示这个菜单：

```
career-ops — 中国大陆求职指挥中心

可用命令：
  /career-ops {贴一段 JD 或 URL}
                       → AUTO-PIPELINE：评估 + report + PDF + tracker 一条龙

  /career-ops oferta   → 单岗位 A-F 完整评估（不自动生成 PDF）
  /career-ops ofertas  → 多 offer 对比 + 加权评分
  /career-ops pdf      → 单独生成 ATS 优化的定制简历 PDF
  /career-ops scan     → 扫描招聘门户发现新岗位（写入 pipeline.md）
  /career-ops pipeline → 批处理 pipeline.md 里的待办 URL
  /career-ops batch    → 批量并行评估多个岗位
  /career-ops tracker  → 查看申请状态汇总

  /career-ops contacto → 主动触达：脉脉/微信/LinkedIn 消息草稿
  /career-ops deep     → 生成公司深度调研 prompt（中文数据源）
  /career-ops apply    → 实时申请表助手（读屏幕 + 生成回答）

  /career-ops training → 评估课程/证书是否值得学
  /career-ops project  → 评估 portfolio 项目的 ROI

待办收件箱：把 URL 加进 data/pipeline.md → /career-ops pipeline
或者直接贴 JD 启动完整 pipeline。
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

### Modes that require `_shared.md` + their mode file:
Read `modes/_shared.md` + `modes/{mode}.md`

Applies to: `auto-pipeline`, `oferta`, `ofertas`, `pdf`, `contacto`, `apply`, `pipeline`, `scan`, `batch`

### Standalone modes (only their mode file):
Read `modes/{mode}.md`

Applies to: `tracker`, `deep`, `training`, `project`

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
