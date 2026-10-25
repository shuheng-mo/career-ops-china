# 飞书集成

career-ops-china 通过 [lark-cli](https://github.com/larksuite/lark-cli) 接入飞书，解决的是**投出去之后**的问题：表格里的 Status 不会提醒任何人，「三天后记得跟进」只存在于你的脑子里。这里把提醒做成飞书任务和日程，把回复和面试结果记成结构化数据，再用这些数据判断「现在该不该继续投」。

飞书是**可选插件层**。核心流程（评估 / tracker / PDF / scan）从不依赖它。

---

## 能力总览与开关

在 `config/profile.yml` 里配置：

```yaml
feishu:
  enabled: true
  profile: "<你的 lark-cli profile 名>"   # 必填，绝不回落到 CLI 的默认 profile
  capabilities:
    bitable: true      # tracker 后端（实际开关是 tracker.backend）
    calendar: true     # 面试日程
    task: true         # 跟进提醒 + 面试前 24h 过简历
    im_card: true      # 每日摘要私信
    dashboard: true    # 多维表格仪表盘
    docs: true         # CV PDF 挂到记录
  config:
    self_open_id: ""   # 日报接收人 = 你自己，用 `lark-cli whoami --profile <p>` 查
```

| capability | 作用 | scope 域 | 关闭 / 不可用时 |
|---|---|---|---|
| `bitable` | tracker 后端 | base | `tracker.backend: md` |
| `calendar` | 面试日程、忙闲推荐 | calendar | 写入 `data/reminders.md` |
| `task` | 跟进 / 结案 / 面试前提醒 | task | 写入 `data/reminders.md` |
| `im_card` | 每日摘要私信 | im | 打印到终端 |
| `dashboard` | 多维表格仪表盘 | base | 只在终端输出漏斗 |
| `docs` | CV PDF 上传到记录 | drive | 文件留在 `output/` |

**插件约定**：每个飞书动作返回 `{ ok, skipped, ... }` 三态之一。能力关闭时返回 `skipped: true`，调用方按成功处理，打印一行降级提示。验收方式就是把 `feishu.enabled` 改成 `false` 把全流程跑一遍。

## 先跑体检

```bash
npm run feishu:check
```

只读、不登录、不写入、不打印 secret。它分别检查三件独立的事：

| 层 | 看什么 | 坏了的表现 |
|---|---|---|
| 开关 | `feishu.enabled` + `capabilities.*` | 调用静默 skip，看起来像「没反应」 |
| 身份 | lark-cli profile 能否解析成已登录用户 | 所有命令报错，看起来像缺权限 |
| scope | token 实际带的 scope | 能读、一写就失败（`91403` / `missing_scope`） |

三者的报错很像，混在一起能浪费一下午，这就是它存在的原因。

缺 scope 时按最小权限补：先 `lark-cli auth scopes --profile <p>` 看应用侧开了什么（应用没开的 scope 用户授权也拿不到），再 `lark-cli auth login --profile <p> --domain <domain> --no-wait --json` 拿授权链接。

---

## 多维表格 Tracker

默认 tracker 是 `data/applications.md` 一张 Markdown 表。记录多了以后缺看板、筛选、公式和多视图，就该切到多维表格。

| 后端 | 特点 | 适合 |
|---|---|---|
| `md`（默认） | `applications.md` 是唯一源，零依赖，git diff 友好 | 记录少、不想装额外工具 |
| `bitable` | 多维表格是唯一写源；`applications.md` 变成 `tracker:export` 生成的**只读快照** | 记录多、想看看板和漏斗 |

### 启用

```bash
# 前置：装好 lark-cli 并登录，profile.yml 里填好 tracker.bitable.profile
npm run tracker:setup       # 交互式：自动建 Base + 表 + 字段 + 视图，或粘贴已有 Base URL
npm run tracker:migrate     # applications.md → 多维表格（幂等，可重跑）
npm run tracker:backfill    # 从 reports/ 补 URL，为历史终止记录补 Closed At
# 最后把 profile.yml 改成 tracker.backend: bitable
```

其他命令：

```bash
npm run tracker:export      # 多维表格 → applications.md 只读快照
npm run tracker:reconcile   # 对比线上 schema 与代码定义，补缺失的字段 / 视图
npm run tracker:backfill-track   # 为没有 Track 的历史记录补方向
```

切回 md：把 `tracker.backend` 改回 `md` 即可。md 就是最新快照，不丢数据；多维表格不删，随时可以再切回去。

### 主表结构

| 分组 | 字段 |
|---|---|
| 基础列（与 md 对齐） | Num、Date、Company、Role、Score、Status、PDF、URL、Report、Notes |
| 生命周期 | Closed At（变成 Rejected / Discarded / SKIP / Offer 时自动记今天）、CV PDF（附件）、Track（方向） |
| 漏斗明细 | Channel、Applied At、First Response At、First Response、Furthest Stage、Exit Stage |
| 公式（只读） | Days Since Added、Score Value（「4.2/5」→ 4.2，用于排序）、Direction、Lifecycle Flag（🎯 活跃 / ⏰ 该 follow-up / 🔥 高优待投 / 🔒 已结束 …） |

视图：`All`、`待投（Evaluated，按分降序）`、`Kanban by Status`（拖卡片改状态）、`按方向分组（Direction × Track）`。

另有两张按需创建的表：**Interviews**（每轮面试一行）和 **Pulse**（脉搏的每周批次）。

### 改状态时顺手写的字段

Status 只存当前状态，回答不了「多久回复」「挂在哪一轮」。改状态时一起写上：

| 时机 | 字段 |
|---|---|
| 投出去 | `appliedAt`、`channel`（官网 / Boss / 猎聘 / 猎头 / 内推 / LinkedIn / 其他）—— `appliedAt` 是跟进提醒的锚点，不填就没有提醒 |
| 第一次收到任何回复（拒信也算） | `firstResponseAt`、`firstResponse`（拒信 / HR沟通 / 约面） |
| 流程结束 | `exitStage`（简历关 / 一面挂 / … / 无回复 / 岗位关闭 / 录用） |

代码里通过 `tools/tracker-backend.mjs` 的 `updateMany(records)` 写，它对两个后端透明。**改多条一定用 `updateMany`**：`updateApplication` 在多维表格后端每次都要全表拉取来把 `num` 翻译成 `record_id`，循环调用很快就会被限流。

---

## 跟进任务

```bash
npm run followup              # 对账一次
npm run followup -- --dry-run # 只看会做什么
```

多维表格没有变更事件流，状态可能由 Claude、由你在 UI 里手改、或由 `sync-outreach` 改。所以不去拦截每条写入路径，而是**每天对账**：看表格现在的样子，让飞书任务和它一致。

对每条 Applied、还没收到回复、也没有出局阶段的记录：

- **跟进任务**：截止 `appliedAt + 3 天`（超过 14 天就不再建）
- **结案任务**：截止 `appliedAt + 14 天` → 决定是否记为「无回复」
- 截止时间已过的，改成「现在 + 5 分钟」，积压的也会响

一旦有了回复、出局阶段或离开 Applied，对应任务会自动完成。任务描述开头就是岗位链接和渠道，拿着卡片就能直接去跟进。

建议用 launchd / cron 每天早上跑一次 `npm run followup`。

## 面试日程

告诉 Claude 某条进面试了，它会调用 `tools/feishu/schedule.mjs`：

- `createInterviewEvent()`：建日程，描述里写 JD 摘要、公司调研和提问清单（支持 Markdown），并自动挂一个提前 24h「过一遍简历，确认口径一致」的任务
- `suggestSlots()`：HR 问「哪天方便」时按你的忙闲推荐时段

每个写动作都支持 `dryRun: true`，透传 lark-cli 的 `--dry-run`，只打印请求、不产生外部动作。

## 面试复盘表

```bash
npm run interview -- add <num> <一面|二面|三面|HR面|终面|笔试> <YYYY-MM-DD> <通过|挂|待定|取消> \
  --format 视频 --feedback "面试官原话"
npm run interview -- list [<num>]
```

主表只能告诉你「这次走到了哪、在哪结束」。「二面挂了两次」要能看出两次都是系统设计那一轮，才有改进的抓手。写入一轮会自动回写主表：

- `Furthest Stage` = 目前走到的最远一轮
- 结果是「挂」→ `Exit Stage` 记为「<轮次>挂」，Status 改为 Rejected
- 其他结果 → Status 改为 Interview（已经终止的不动）

不要手动改这三个字段。md 后端下回落到 `data/interviews.jsonl`。

## 投递脉搏

```bash
npm run pulse                  # 默认看最近 21 天
npm run pulse -- --window 28
npm run pulse -- --sync        # 把每周批次写进 Pulse 表并补看板图表
```

要回答的问题：**这一批投递，按它们已经投出去的天数和渠道，该收到的回复收到了吗？**

- **删失处理**：昨天才投的只给了一天时间，算成「没回复」会让每个新批次都看起来很糟。所以回复率按生存曲线算：`R(d)` 只统计投出去至少 `d` 天的记录
- **按渠道算基线**：官网两周才回很正常，Boss 两周没动静就不正常。每个渠道用你自己的历史数据单独算曲线
- **模型**：每条投递按基线算出「到今天应该已经回复」的概率 `pᵢ`，期望回复数 `E = Σpᵢ`，实际回复数为 `O`。假设一切照旧，则 `O ~ Poisson(E)`，用尾概率 `P(X ≤ O | E)` 当信号：

| 尾概率 | 信号 | 含义 |
|---|---|---|
| < 0.05 | 🟥 暂停投递 | 如果简历和定位还像以前一样好，回复不会这么少。先停下来改，再继续投 |
| < 0.20 | 🟨 观察 | 低于预期，不要加量 |
| 其他 | 🟩 正常 | |

`E < 2` 时样本不够，报告会说还要等多久才能判断，而不是硬给结论。另外单独检查速度：窗口内首次回复天数的中位数超过基线 1.5 倍，说明回复虽然来了、但变慢了。阶段转化把「简历没打动人」（简历关 / 无回复为主）和「面试没过」（一面挂为主）分开，两者的改法完全不同。

**出现 🟥 时，先复盘简历、渠道和定位，不要继续加量投递。**

## 漏斗看板

```bash
npm run feishu:insights                # 终端里看分方向漏斗
npm run feishu:insights -- --dashboard # 同步到多维表格仪表盘
```

漏斗在本地基于 tracker 抽象层计算，两个后端都能用，不需要飞书。仪表盘只是把同样的数字做成图表，方便在手机上看。重复运行会复用同名仪表盘，不会堆出多份。

没有用 `base +data-query` 做云端聚合：lark-cli 的查询规范里，单表 2000 行以下推荐读记录后本地分析。云端聚合在这个规模下更慢、不支持多表 JOIN，而且 md 后端用不了。

## 每日摘要

```bash
npm run feishu:digest -- --dry-run   # 看今天的摘要长什么样
npm run feishu:digest                # 发送
```

由**机器人**发到你的私聊，而不是你用自己的身份发给自己。后者会进飞书的自聊会话，不会触发通知，摘要发了也看不到，正好重现了这个功能要解决的「状态没人看」问题。

刻意做成单向：没有按钮、没有回调、没有常驻进程。摘要里放多维表格链接，你在那里改状态。用 Markdown 而不是交互卡片，因为摘要类内容用卡片没有收益，`--markdown` 也是 lark-cli 推荐的报告形式。

## 简历附件

```bash
node tools/feishu/docs.mjs <num> <pdf 路径>
```

tracker 的 `PDF` 列只是一个勾，记录的是「有 PDF」，不是「投的是哪版」。面试当天早上，你最需要知道的恰恰是这家拿到的是哪个版本。这个命令把实际投出去的 PDF 上传到该记录的 `CV PDF` 附件格。

只给真正要投的岗位挂。重新上传是追加而不是替换，旧附件需要手动删。

---

## 安全护栏

所有 lark-cli 调用只经过 `tools/feishu/capabilities.mjs` 的 `runLarkCli()`，在一个地方保证：

1. **必带 `--profile`**：CLI 的默认 profile 是全局可变状态，别的会话跑一次 `lark-cli profile use` 就会把写入静默打到另一个租户。未配置时直接报错，绝不回落默认值
2. **必带 `--format json`**：lark-cli ≥ 1.0.48 默认输出 markdown，会让所有下游解析失效
3. **写操作自动 `--as user`**：机器人身份只读，写会报 `91403`
4. **节流 ~5 req/s**

**永不自行加 `--yes`。** 删除记录 / 字段 / Base 这类破坏性操作需要这个参数，CLI 明确要求 agent 不得自己加。这类操作只打印命令，交给你自己执行。

---

## 踩坑记录

每一条都是真实遇到过的问题。

| 坑 | 规避 |
|---|---|
| `--json` 是扁平对象，没有 `{"fields":{...}}` 包装 | 字段名直接作为顶层 key |
| 分页是 `--limit`（默认 100）+ `--offset`，不是 `--page-size` | 靠响应里的 `has_more` 判断终止 |
| 响应是列式：`data.fields[]` + `data.data[]` + `data.record_id_list[]` | 三者 zip 回对象 |
| 日期写入用 `"YYYY-MM-DD HH:mm:ss"` 字符串，不是毫秒时间戳 | 读取时同时兼容字符串和数字 |
| 单选字段返回数组 `["Evaluated"]` | 取值时解包 |
| 单选写入值必须是预先建好的选项 | 加新状态前先在表里加选项 |
| 公式字段的输出类型只在创建时根据首个 token 推断一次 | 文本用 `"" & (...)`，数字用 `0 + (...)`，日期用 `TODATE(...)`。改类型只能删字段重建 |
| 视图筛选对公式字段做数值比较会静默失效（API 返回成功但条数不对） | 筛选只用原生存储字段，公式只用于展示和排序 |
| 创建公式字段需要 `--i-have-read-guide` | 并且要真的先读 guide |
| 不要写公式 / lookup 字段 | 写入 payload 里显式排除 |
| 单选颜色是封闭集合，没有 `Violet` | 紫色写 `Purple` |
| 批量上限 500 条 / 请求 | 批次之间 sleep 1s |
| 错误可能打在 stdout 而不是 stderr | 分类时两个流都读 |
| 错误分类有顺序：「auth」出现在每条命令的 help 文本里 | 先判 usage → 再 auth → 再 permission → 兜底，否则参数拼错会被报成授权问题 |
| 部分命令先输出多行诊断信息再输出 JSON | 解析失败时用正则抓末尾的 JSON |
| 自己发给自己的消息不会触发通知 | 日报用机器人身份发 |
