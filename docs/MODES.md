# 命令模式

在 Claude Code 里输入 `/career-ops` 查看全部命令。每个 mode 对应 `modes/` 下的一个 markdown 文件。

## 全部模式

| 模式 | 触发 | 做什么 |
|---|---|---|
| **auto-pipeline** | 直接贴 JD 文本 / 截图 / URL | 完整流程：A-F 评估 + report + 定制简历 PDF + 写入 tracker |
| **inbox** | `/career-ops inbox` | 处理 bookmarklet / 接口脚本抓到的 `inbox/*.json`，逐条评估，处理完移到 `processed/` |
| `offer` | `/career-ops offer` + JD | 只跑 A-F 评估，不生成 PDF |
| `offers` | `/career-ops offers` | 多个 offer 加权对比和排序 |
| `pdf` | `/career-ops pdf` | 单独生成定制简历 |
| `scan` | `/career-ops scan` | 线索发现（只要 URL + 标题，不取 JD） |
| `radar` | `/career-ops radar` | 管理云端定期运行的线索雷达 routine |
| `pipeline` | `/career-ops pipeline` | 处理 `data/pipeline.md` 里的待办 URL |
| `batch` | `/career-ops batch` | 用多个 `claude -p` worker 并行评估 |
| `tracker` | `/career-ops tracker` | 投递状态汇总 |
| `apply` | `/career-ops apply` | 实时申请表助手：读表单，生成每个问题的回答 |
| `contact` | `/career-ops contact` | 脉脉 / 微信 / Boss / LinkedIn 触达的要点草稿 |
| `deep` | `/career-ops deep` | 公司深度调研（中文数据源） |
| `training` | `/career-ops training` | 评估某个课程 / 证书值不值得学 |
| `project` | `/career-ops project` | 评估某个作品集项目的投入产出 |
| `story-sync` | `/career-ops story-sync` | 从所有 report 抽 Block F，去重后累积到面试故事库 |

`modes/feishu.md` 不是独立命令，而是飞书集成的配置、授权和体检说明，见 [FEISHU.md](FEISHU.md)。

## 使用示例

### 评估单个 JD

```
你：[贴一段 JD]

Claude：
1. 先过红线；命中就直接 SKIP 并说明原因
2. 识别 archetype 和 Track
3. Block A–F：角色摘要 / CV 逐条匹配 / 级别策略 / 薪酬与口碑 / 改简历建议 / 面试故事
4. 写 reports/{NNN}-{公司}-{日期}.md
5. 生成 output/*.md 定制简历 → npm run cv 出 PDF
6. 写 tracker TSV → npm run merge 合并
7. 给出总分、推荐动作和谈薪锚点
```

### Bookmarklet + inbox（国内主路径）

```
一次性：npm run inbox-server → npm run build-bookmarklets → 把按钮拖到书签栏
日常：  打开 JD 页 → 点按钮 → 攒几个 → /career-ops inbox
```

详见 [JD-CAPTURE.md](JD-CAPTURE.md)。

### 线索发现

```
你：/career-ops scan

Claude：按 portals.yml 搜索 → 过滤标题和红线 → 三重去重
       → 写入 data/pipeline.md（带优先级和取 JD 方式）
       → 提示下一步用 bookmarklet / 截图取 JD
```

### 申请表助手

```
你：/career-ops apply（浏览器里开着申请表）

Claude：读表单 → 找到对应 report → 为每个问题写回答
       → 国内特有问题单独处理（期望薪资 / 到岗时间 / 能否加班 / 婚育）
       → 输出可直接复制的文本。提交按钮由你来点
```

### 投出去之后

```bash
npm run followup        # 跟进任务对账
npm run pulse           # 回复是否符合预期
npm run interview -- add <num> 一面 2026-11-02 通过 --feedback "..."
```

---

## 让 Claude 帮你定制

这个项目最大的特点是 **Claude 能直接改它自己的所有文件**。用得不顺手，直接说：

| 你说 | Claude 会改 |
|---|---|
| 「加一个 SRE 方向的 archetype」 | `modes/_profile.md` |
| 「我不太在意工时了，权重调低」 | `modes/_profile.md`（个人权重） |
| 「把这 5 家公司加进 portals」 | `portals.yml` |
| 「把『大小周』从红线里去掉」 | `config/profile.yml` |
| 「我现在主攻后端了」 | `modes/_profile.md` 的 archetype 和叙事 |
| 「这个分太高了，因为 X」 | 调整 `_profile.md` 的叙事角度或在 `profile.yml` 加备注 |

系统越用越准。

## 换方向

预置配置（archetype、目标公司、薪资调研关键词、红线模板）是围绕数据和 AI 方向做的，但工作流本身与岗位无关：A-F 评估、CV 匹配、薪资调研、tracker、PDF、bookmarklet、飞书集成都通用。

| 你的方向 | 需要改的 |
|---|---|
| 后端 / 全栈 / SRE | `modes/_profile.md` 的 archetype 表 + `portals.yml` 的 `title_filter` 和目标公司 |
| 前端 / 客户端 | 同上，并把前端 / iOS / Android 从 negative 移到 positive |
| 产品 / 运营 / 增长 | 换 archetype，评分维度从技术栈改为业务能力 |
| 算法研究 | archetype 改为 Research Scientist，加上顶会关键词 |
| 销售 / 市场 / HR / 法务 | 重写 archetype，评分维度改为行业经验 / 客户资源 / 语言能力 |
| 海外岗位 | 用上游 [`santifer/career-ops`](https://github.com/santifer/career-ops) 更合适 |

一句话就够：「我是做 X 的，把整个系统调整到这个方向」。
