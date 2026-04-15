# Mode: inbox — 处理浏览器 bookmarklet 捕获的 JD

候选人在浏览器用 bookmarklet 一键捕获 JD → 发到本地 inbox/ 服务器 → 落盘成 JSON 文件。
本 mode 读取 `inbox/*.json`，对每个新文件跑完整 auto-pipeline（评估 + report + PDF + tracker），处理完移到 `inbox/processed/`。

## Workflow

1. **列文件：** `ls inbox/*.json | sort`（排除 .gitkeep 和 processed/）
2. **如果空：** 告诉用户 inbox 为空，提示安装 / 使用 bookmarklet 的方法
3. **如果有 1 个：** 直接处理（不启 subagent）
4. **如果有 3+ 个：** 启 subagent 并行处理（同 batch mode 风格）
5. **每个文件：**
   a. `Read` JSON
   b. 用 `extracted.description`（如非空且 >200 字）作为 JD，否则用 `extracted.raw_text`
   c. 计算 `REPORT_NUM`（reads `reports/`，max + 1）
   d. 跑 auto-pipeline 完整 A-F 评估 + report + PDF（score >= 3.0）+ tracker TSV
   e. 处理完 `mv inbox/{file}.json inbox/processed/{file}.json`
6. **结束：** 输出汇总表 + 提示用户跑 `npm run merge`（即 `node tools/merge-tracker.mjs`）

## JSON Schema（inbox 文件格式）

```json
{
  "url": "https://...",
  "page_title": "...",
  "captured_at": "2026-04-14T08:30:00.000Z",
  "platform": "boss-zhipin | liepin | lagou | mokahr | dachang-spa | universal",
  "extracted": {
    "job_title": "高级数据工程师",
    "company": "字节跳动",
    "location": "北京",
    "salary": "30k-60k",
    "department": "...",            // optional
    "seniority_experience": "...",  // optional
    "description": "...",           // 优先用这个
    "requirements": "...",          // optional
    "raw_text": "..."               // 兜底，整页 innerText
  }
}
```

**字段使用规则：**

| 优先 | 字段 | 用途 |
|------|------|------|
| 1 | `extracted.description` | 主 JD 内容（如果 bookmarklet 抽到了结构化字段）|
| 2 | `extracted.raw_text` | 兜底，整页文本，从中识别 JD |
| — | `url`, `company`, `job_title` | 用于 report 头、PDF 命名、tracker 字段 |
| — | `platform` | 标记来源，写进 report 验证状态段 |

**特别注意：** Mokahr / Boss 等反爬平台抓到的 `extracted.*` 可能字段缺失或不准。**永远先看 raw_text** 找 JD 真实内容，不要被空字段误导。

## 输出汇总（用户视角）

```
inbox 处理 — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
处理文件：N
跳过（重复 / 空内容）：N

| # | 公司 | 岗位 | Score | PDF | 来源 |
|---|------|------|-------|-----|------|
| 003 | DeepSeek | Agent 数据策略 | 4.7/5 | ✅ | mokahr |
| 004 | 字节 | 数据工程师 | 3.9/5 | ✅ | dachang-spa |
| 005 | 某公司 | XX | 2.5/5 | ❌ | boss-zhipin |

→ 跑 npm run merge（node tools/merge-tracker.mjs）把 TSV 合并进 applications.md
```

## 服务器使用提醒

如果用户问"怎么用 bookmarklet"：
1. 终端跑 `node tools/jd-inbox-server.mjs`（或 `npm run inbox-server`）
2. 浏览器打开 `tools/install.html`，把按钮拖到书签栏
3. 在 JD 页面点 bookmarklet → 看到 ✓ 提示
4. 回 Claude 跑 `/career-ops inbox`

## 去重

处理前先检查：
- 同 URL 是否已在 `data/applications.md`（公司 + 岗位归一化）
- 同 URL 是否已在 `inbox/processed/`

如重复 → 询问用户：覆盖评估 / 跳过 / 当作新岗位再评

## 出错处理

- JSON 解析失败 → 移到 `inbox/errors/{file}.json`，记录原因，继续下一个
- raw_text 空（< 100 字）→ 跳过，提示用户重新捕获
- WebSearch / WebFetch 在评估 Block D 失败 → 评估继续，标注"薪酬数据未查到"
