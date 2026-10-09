# Mode: tracker — 申请追踪器

## 读取

**永远通过抽象层读，不要直接解析 `data/applications.md`。**

```
node -e 'import("./tools/tracker-backend.mjs").then(async m => {
  const apps = await m.listApplications();
  // ...
})'
```

`data/applications.md` 在 `tracker.backend: bitable` 下是 **`tracker:export` 生成的只读快照** —— 可以读它来快速看一眼，但它可能落后于真源一次 export。要准确数据就走 `listApplications()`。

**当前列（12 列，`Track` 在 Phase 2 加入）：**

```
| # | Date | Company | Role | Score | Status | PDF | URL | Report | Notes | Closed At | Track |
```

⚠️ 不要按位置索引硬编码取列 —— 列数变过两次（9 → 11 → 12）。要么走抽象层拿规范化 record，要么从表头推导列索引（参考 `tools/verify-pipeline.mjs` 的 `findColumnMap`）。

## 状态机

`Evaluated`（已评估）→ `Applied`（已申请）→ `Responded`（已回复）→ `Interview`（面试中）→ `Offer` / `Rejected` / `Discarded` / `SKIP`，外加 `Blocked`。

| 状态 | 含义 | 终态？ |
|---|---|---|
| `Evaluated` | 已生成 report，未决定是否投 | — |
| `Blocked` | 命中证据缺口闸门（如智驾感知岗缺 CV 项目证据），**等补齐证据后可解锁** | 否（活态） |
| `Applied` | 候选人已投递 | — |
| `Responded` | 公司有回应（HR 加微信、约电话），还没正式进面试 | — |
| `Interview` | 已进面试流程 | — |
| `Offer` | 已拿 offer | 是 |
| `Rejected` | 公司拒了 | 是 |
| `Discarded` | 候选人自己撤了或岗位关闭 | 是 |
| `SKIP` | 不匹配，根本不投 | 是 |

终态由 `tools/tracker-backend.mjs` 的 `TERMINAL_STATES` 定义，进入终态时后端会自动补 `Closed At`。

## 更新状态

**不要编辑 `data/applications.md`。** 两条合法路径：

1. **代码**：`updateApplication(num, { status, notes })`；一次改多条用 `updateMany([{num, ...}, ...])`
   ⚠️ 不要循环调 `updateApplication` —— Bitable 后端每次都会全量拉表来把 `num` 翻译成 `record_id`，N 条 = N 次全表拉取。
2. **人工**：直接在 Bitable UI 改（`backend: bitable` 时这是最自然的方式，原生 enum 保证值合法）

改完 Bitable 后跑 `npm run tracker:export` 刷新本地快照。

## 展示统计

- 总申请数 / 各状态数量（`aggregateByStatus()`）
- 平均 Score、PDF 生成率、Report 生成率
- 平均流程时长（投递 → 回复 → 面试 → offer）
- 拒信率 / Offer 率
- **分 Track 漏斗**（Phase 2 后）：各方向的投递数 / 回应率 / 进面率 —— 这是判断「哪个方向值得继续投」的依据

⚠️ 统计时注意 2026-07-03 ~ 2026-10-08 的停摆：那之前的 240 条是历史存量，回应率不要和重启后的新投递混算。
