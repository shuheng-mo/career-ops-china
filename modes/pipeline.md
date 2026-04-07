# Mode: pipeline — URL 收件箱（Second Brain）

处理 `data/pipeline.md` 中累积的待评估 URL。用户随时把 URL 加进去，然后跑 `/career-ops pipeline` 一次性全部处理。

## Workflow

1. **读** `data/pipeline.md` → 找 "待处理" 段里的 `- [ ]` 条目
2. **对每个待处理 URL：**
   a. 计算下一个 `REPORT_NUM`（读 `reports/`，找最大序号 + 1）
   b. **提取 JD** → Playwright (browser_navigate + browser_snapshot) → WebFetch → WebSearch
   c. 如果 URL 不可访问 → 标 `- [!]` 加备注，继续下一个
   d. **跑完整 auto-pipeline**：A-F 评估 → Report .md → PDF（如果 score >= 3.0）→ Tracker
   e. **从 "待处理" 移到 "已处理"**：`- [x] #NNN | URL | 公司 | 岗位 | Score/5 | PDF ✅/❌`
3. **如果有 3+ 个待处理 URL**，启 Agent 并行（用 `run_in_background`）加速。**注意**：Playwright 不能并行（共享浏览器），用 Playwright 的 agent 顺序跑。
4. **结束时**显示汇总表：

```
| # | 公司 | 岗位 | Score | PDF | 推荐动作 |
```

## pipeline.md 格式

```markdown
## 待处理
- [ ] https://jobs.bytedance.com/positions/123
- [ ] https://www.deepseek.com/careers/data-engineer | DeepSeek | 数据工程师
- [!] https://liepin.com/job/xxx — Error: 需要登录

## 已处理
- [x] #143 | https://jobs.bytedance.com/positions/789 | 字节跳动 | 数据开发 | 4.2/5 | PDF ✅
- [x] #144 | https://www.zhipin.com/job_detail/xxx | 某公司 | 后端 | 2.1/5 | PDF ❌
```

## 国内 URL 的特殊处理

| 域名 | 处理方式 |
|------|---------|
| `jobs.bytedance.com` / `talent.alibaba.com` / `careers.tencent.com` 等大厂自有域 | Playwright 直抓，通常 OK |
| `zhipin.com`（Boss直聘） | **多数登录墙**，标 `[!]`，让用户手动贴 JD |
| `lagou.com` | 列表可能可访问，详情常需登录 |
| `liepin.com` | 同上 |
| `maimai.cn`（脉脉招聘） | 必须登录 → `[!]` |
| `linkedin.com/jobs` | 需要登录 → `[!]` 或让 Claude 用 chrome 模式 |

## 智能 JD 检测

1. **Playwright（首选）：** `browser_navigate` + `browser_snapshot`。能处理所有 SPA。
2. **WebFetch（fallback）：** 静态页或 Playwright 不可用时。
3. **WebSearch（最后手段）：** 在二级招聘站找 HTML 缓存。

**特殊情况：**
- **登录墙**：标 `[!]`，让用户手动贴 JD 文本
- **PDF**：如果 URL 是 PDF，直接用 Read tool 读
- **`local:` 前缀**：读本地文件。例：`local:jds/字节跳动-data-eng.md` → 读 `jds/字节跳动-data-eng.md`

## 自动编号

1. 列出 `reports/` 所有文件
2. 提取前缀的数字（如 `142-bytedance-...` → 142）
3. 新编号 = 找到的最大值 + 1

## 源同步检查

处理任何 URL 之前，检查同步状态：
```bash
node cv-sync-check.mjs
```
如果有 desync，警告用户后再继续。
