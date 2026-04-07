# Mode: tracker — 申请追踪器

读取并展示 `data/applications.md`。

**Tracker 格式：**
```markdown
| # | 日期 | 公司 | 岗位 | Score | 状态 | PDF | Report |
```

状态机（保持英文 canonical，方便脚本处理）：
`Evaluated`（已评估）→ `Applied`（已申请）→ `Responded`（已回复）→ `Interview`（面试中）→ `Offer`（拿到 offer）/ `Rejected`（被拒）/ `Discarded`（自己放弃）/ `SKIP`（不投）

含义：
- `Evaluated` — 已生成 report，未决定是否投
- `Applied` — 候选人已投递
- `Responded` — 公司有回应（HR 加微信、约电话），但还没正式进面试
- `Interview` — 已进面试流程
- `Offer` — 已拿 offer
- `Rejected` — 公司拒了
- `Discarded` — 候选人自己撤了或岗位关闭
- `SKIP` — 不匹配，根本不投

如果用户要更新状态，编辑对应行。

**展示统计：**
- 总申请数
- 各状态数量
- 平均 Score
- PDF 生成率
- Report 生成率
- 平均流程时长（投递 → 回复 → 面试 → offer）
- 拒信率 / Offer 率
