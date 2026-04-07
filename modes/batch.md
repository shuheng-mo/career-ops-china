# Mode: batch — 批量处理岗位

两种用法：**conductor --chrome**（实时浏览门户）或 **standalone**（已收集好的 URL 列表）。

## 架构

```
Claude Conductor (claude --chrome --dangerously-skip-permissions)
  │
  │  Chrome：浏览门户（可以复用登录态）
  │  直接读 DOM — 用户实时看到一切
  │
  ├─ 岗位 1：从 DOM 读 JD + URL
  │    └─► claude -p worker → report .md + PDF + tracker-line
  │
  ├─ 岗位 2：点下一个，读 JD + URL
  │    └─► claude -p worker → report .md + PDF + tracker-line
  │
  └─ 结束：merge tracker-additions → applications.md + 汇总
```

每个 worker 是一个独立的 `claude -p` 子进程，有 200K token 的干净上下文。Conductor 只负责编排。

## 文件

```
batch/
  batch-input.tsv               # URL 列表（conductor 自动写入或手动）
  batch-state.tsv               # 进度（自动生成，gitignored）
  batch-runner.sh               # 独立模式的编排脚本
  batch-prompt.md               # worker 的 prompt template
  logs/                         # 每个岗位一个 log（gitignored）
  tracker-additions/            # tracker 待合并的行（gitignored）
```

## 模式 A：Conductor --chrome（适合中国大陆）

**这是国内门户的最佳模式** — 你登录 Boss直聘 / 拉勾 / 脉脉招聘后，让 Claude 用同一个 Chrome 实例浏览。

1. **读状态**：`batch/batch-state.tsv` → 知道哪些已处理
2. **导航门户**：Chrome → 搜索 URL（如 Boss 直聘的搜索结果页）
3. **提取 URL**：从 DOM 读结果列表 → 提取 URL 列表 → append 到 `batch-input.tsv`
4. **对每个待处理 URL：**
   a. Chrome：点开岗位 → 从 DOM 读 JD 文本
   b. JD 存到 `/tmp/batch-jd-{id}.txt`
   c. 计算下一个 REPORT_NUM
   d. 通过 Bash 执行：
      ```bash
      claude -p --dangerously-skip-permissions \
        --append-system-prompt-file batch/batch-prompt.md \
        "处理这个岗位。URL: {url}。JD: /tmp/batch-jd-{id}.txt。Report: {num}。ID: {id}"
      ```
   e. 更新 `batch-state.tsv`（completed/failed + score + report_num）
   f. log 到 `logs/{report_num}-{id}.log`
   g. Chrome：返回上一页 → 下一个岗位
5. **翻页**：如果当前页没有更多 → 点 "下一页" → 重复
6. **结束**：merge `tracker-additions/` → `applications.md` + 汇总

**国内门户的反爬注意事项：**
- **降速**：每个岗位之间加 5-10 秒随机延迟
- **不要并行**：Boss/拉勾会按 IP 封禁，串行跑
- **检测验证码**：如果遇到滑块/手机验证，conductor 应该停下来等候选人手动过验证
- **小批量**：一次跑 10-30 个岗位，不要一晚上跑 500 个 — 会被风控

## 模式 B：独立脚本

```bash
batch/batch-runner.sh [OPTIONS]
```

选项：
- `--dry-run` — 列待处理，不执行
- `--retry-failed` — 只重试失败的
- `--start-from N` — 从 ID N 开始
- `--parallel N` — N 个并行 worker（**国内门户不要用并行**）
- `--max-retries N` — 每个岗位的尝试次数（默认 2）

## batch-state.tsv 格式

```
id	url	status	started_at	completed_at	report_num	score	error	retries
1	https://...	completed	2026-...	2026-...	002	4.2	-	0
2	https://...	failed	2026-...	2026-...	-	-	错误信息	1
3	https://...	pending	-	-	-	-	-	0
```

## 可恢复性

- 中断后 → 重跑 → 读 `batch-state.tsv` → 跳过已完成
- Lock file（`batch-runner.pid`）防止重复运行
- 每个 worker 独立：第 47 个岗位失败不影响其他

## Workers (claude -p)

每个 worker 收到 `batch-prompt.md` 作为 system prompt。是 self-contained 的。

worker 产出：
1. Report `.md` 在 `reports/`
2. PDF 在 `output/`
3. tracker line 在 `batch/tracker-additions/{id}.tsv`
4. 结果 JSON 通过 stdout

## 错误处理

| 错误 | 恢复 |
|------|-----|
| URL 不可访问 | worker 失败 → conductor 标 `failed`，下一个 |
| JD 在登录墙后 | conductor 试着读 DOM。失败 → `failed`，让候选人手动处理 |
| 门户布局变了 | conductor 推理 HTML，自适应 |
| Worker 崩溃 | conductor 标 `failed`，下一个。用 `--retry-failed` 重试 |
| Conductor 死 | 重跑 → 读 state → 跳过已完成 |
| PDF 失败 | report .md 已存。PDF 留 pending |
| **滑块/手机验证（国内特有）** | conductor 暂停，等候选人手动过验证后输入 "continue" |
