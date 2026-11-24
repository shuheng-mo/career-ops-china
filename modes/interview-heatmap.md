# Mode: interview-heatmap — 复盘统计（Heatmap 数据层）

真实面试问题频率、掌握度与复习优先级。规格：`docs/interview-studio/spec-v0.2.md`（§6.1）。

## 命令

`/career-ops interview-heatmap [--track ai-app] [--round 一面]`

CLI：`npm run interview:kb -- stats [--track <t>] [--round <r>] [--days 180] [--json]`

## 读法（agent 解读时遵守）

- **只有真实面试进频率**（historical_import / real_*）：mock、预测（JD/Block F/CV 推导）、练习都不进分母——冷启动显示「暂无真实面试样本」是正常态，不是 bug
- **k/n 展示**：频率 = 命中 session 数 / 可用 session 数；样本 <5 时提示低样本，不下概率结论
- **掌握度**：最近 ≤5 次独立回答（盲测/真实无提示）的 rubric 加权均分；assisted（看提示练的）单列不混入；事实冲突块 ⛔ 不计掌握度
- **优先级** = 0.25·频率 + 0.35·(1−掌握) + 0.25·相关 + 0.10·风险 + 0.05·遗忘（缺维度按剩余权重归一）
- ⛔ needs_review 的块先核对事实口径，再谈练习
- 排序是启发式不是预测；向用户展示时给依据（命中证据可从 review.json 追溯）

## 典型动作

1. `stats` 看全局 → 找 high priority + low mastery 的块
2. 对这些块发起 `interview-prep dig` 补答案，或安排一次 mock_blind 练习（练习结果回填掌握度）
3. 低频块（≥10 场无命中）讨论是否归档——归档必须人工批准（patch archive）
