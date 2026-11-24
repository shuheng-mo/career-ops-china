# Mode: interview-review — 面试复盘（逐字稿 → 对齐 → rubric 评审）

把一场真实/模拟面试的逐字稿变成：原话证据 + 知识块对齐 + 要点覆盖 + 事实冲突 + 改进队列。
规格：`docs/interview-studio/spec-v0.2.md`（§5）；CLI 契约见 `docs/INTERVIEW-STUDIO.md`。

## 命令

`/career-ops interview-review 753`（按申请编号），或直接给逐字稿文件。

## Agent 编排（确定性步骤全走 CLI）

1. `transcript import --file <逐字稿> --application <num> --round <一面>` → session（重复导入自动复用，不重复计数）
2. `segment export --session <id> --json` → **agent 回填** segmentation-result（问题切分；寒暄标 non_question；引用 utterance id 不改写原话）
3. `segment apply` → `align export --session <id> --json` → **agent 回填** alignment-result（matched/ambiguous/unmatched/pending；matched 必须带 evidence_refs；都不合适就 unmatched，不得强行对齐）
4. `review prepare --session <id> --json` → **agent 按 rubric 评审**（权重固定 30/25/20/15/10；unknown 不判错；原话引用用 evidence_refs；没有把握就标 unknown）
5. `review apply --session <id> --file <result>` → review.json/md；**把 review.md 给候选人看，人工确认对齐与冲突**
6. 冲突处理：fact_conflicts → 相关块进 needs_review 硬闸门（不计掌握度）；口径核实走 `/career-ops evolve dig` 提案，**不自动改 cv.md**
7. 新问题自动进待确认种子（origin_kind transcript）——下一次 `interview-prep dig` 会带上

## 契约红线

- agent 不直接改知识块/事件文件——一切经 CLI 校验提交
- 角色未确认的 utterance 保持 unknown，不由 agent 拍板
- 历史逐字稿 retrospective=true：没有当时的 pack 就明说，不假装当时已准备
- 复盘产物本地存 `interview-prep/reviews/`，不外发
