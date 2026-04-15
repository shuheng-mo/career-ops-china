# Mode: inbox — 处理浏览器 bookmarklet 捕获的 JD

候选人在浏览器用 bookmarklet 一键捕获 JD → 发到本地 inbox/ 服务器 → 落盘成 JSON 文件。
本 mode 读取 `inbox/*.json`，对每个新文件跑完整 auto-pipeline（评估 + report + PDF + tracker），处理完移到 `inbox/processed/`。

## Workflow

### Phase 0 — 本地 Triage（零工具调用）

1. **列文件：** `ls inbox/*.json | sort`（排除 .gitkeep 和 processed/）
2. **如果空：** 告诉用户 inbox 为空，提示安装 / 使用 bookmarklet 的方法
3. **对每个 JSON 提取元信息**（title / company / real_company via HR 反推 / salary / location / deal-breaker flag）
4. **分类到 4 个桶**：
   - **A. 完整评估**：用户确认处理的高优先级
   - **B. 批量 Discarded**：title 过关但用户决定不做完整评估（P3 低优 / "华为"误报 / 其他 keep 类）
   - **C. SKIP（Deal-breaker）**：真派遣 / 真华为系 / 明确命中候选人 deal-breaker
   - **D. Title-skip**：title 过滤不过关（AI 产品经理 / 数据分析师 / 应届实习 等）

### Phase 1 — 交互式确认（Token 控制）

如果桶 A 候选数 ≥ 5，向用户列清单让选：
- `[a] 仅 top 4`（按 priority 排）
- `[b] top 7`
- `[c] 全跑 {N}`
- `[d] 自选编号`

### Phase 2 — 处理（按桶执行，每个桶都要完整闭环）

| 桶 | 处理 | TSV | Report | PDF | 归档 |
|----|------|-----|--------|-----|------|
| **A 完整评估** | A-F 评估 | ✅ 1 行 | ✅ 完整 | 视 Score / 用户决定 | mv processed/ |
| **B 批量 Discarded** | 无评估 | ✅ 1 行 notes=原因 | ❌ 无 | ❌ | **mv processed/** |
| **C SKIP（Deal-breaker）** | 无评估 | ✅ 1 行 notes=派遣方 | ❌ 无 | ❌ | **mv processed/** |
| **D Title-skip** | 无 | ❌ 不进 applications.md | ❌ | ❌ | **mv processed/** |

### 🚨 铁律：inbox 结束时必须清零

**所有被 triage 过（无论哪个桶）的 JSON 都必须 mv 到 `inbox/processed/`。**

- 不能有"看过但不处理"的 JSON 留在 inbox — 那下次 `/career-ops inbox` 会重复 triage 浪费 token
- 不能有"用户选了 top 4 处理，剩下 10 个留原位" — 剩下 10 个按桶 B 批量 Discarded 处理
- 唯一留 inbox 的情况：**该 JSON 从未被 triage 过**（比如正在处理时用户又抓了新 JD）

### Phase 3 — 合并

输出汇总表 + 提示用户跑 `npm run merge`（即 `node tools/merge-tracker.mjs`）

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
