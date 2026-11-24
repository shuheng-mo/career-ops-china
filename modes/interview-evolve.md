# Mode: interview-evolve — 面试知识演进（patch 审批）

复盘暴露的问题变成知识库的演进提案：同义问 → alias；追问 → 子块；事实质疑 → fact_conflict；缺口 → gap backlog。
规格：`docs/interview-studio/spec-v0.2.md`（§6.2）。

## 命令

`/career-ops interview-evolve`（查看待办提案并逐条处理）

## Agent 编排

1. 收集提案来源：复盘 review.md（事实冲突/新问题）、stats 低频块、`signals reconcile --check-cv` 的 review-flags
2. `patch propose --file <patch.json>` 构造提案（type: alias_add|block_edit|fact_conflict|archive|merge|gap_add；block_add 走 interview-prep 的 approve 路径）
   - base_revision 必须是目标块当前 revision，过时会标 stale 需重建
3. `patch list` 展示 pending，**逐条给用户过目**（before/after diff + reason + 来源）
4. 用户批准 → `patch approve <id>` → `patch apply <id>`；拒绝 → `patch reject <id>`
5. apply 后核对 `practice` 输出与 `stats` 变化

## 契约红线

- **审批门槛**：没有用户明确确认不 apply；批量场景逐条列 diff
- **事实纪律**：fact_conflict 只记冲突到 `knowledge/fact-links.yml`，cv.md 与 evolve 账本一律不自动改（走 `/career-ops evolve`）
- 拒绝过的提案可以人工再提（用户驱动），系统按 target+diff 去重防止重复打扰
- 所有演进写 changelog（`knowledge/versions/CHANGELOG.md`）与 manifest，可回溯
