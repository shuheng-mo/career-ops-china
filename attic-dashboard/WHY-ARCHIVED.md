# 为什么归档

这是一个 ~2100 行的 Go/Bubble Tea 终端看板（管道 Kanban + 指标 + report 阅读器）。2026-10-09 归档，原因有两个：

## 1. 它在当前配置下的写入是无效的

`internal/data/career.go`（603 行）自己手写了一个 `data/applications.md` 的解析器 **和写入器**，完全绕过 `tools/tracker-backend.mjs` 抽象层。`main.go` 的 `PipelineUpdateStatusMsg` 分支调 `data.UpdateApplicationStatus(...)` 直接改 md 文件。

而 `config/profile.yml` 现在是 `tracker.backend: bitable` —— md 是 `npm run tracker:export` 生成的**只读快照**。所以在这个看板里改状态，会被下一次 export 静默覆盖。

## 2. 它的功能已被飞书 Bitable 视图替代

Kanban、分组、指标、状态流转、各阶段停留天数，Bitable 原生视图 + 仪表盘 + formula 字段都能做，且手机上能看、零维护代码。

## 要复活的话

先把 `internal/data/career.go` 的读写换成 shell out 到 `tools/tracker-backend.mjs`（或起一个小 HTTP 桥），让它和 md/bitable 两种后端都兼容。在那之前它只能在 `tracker.backend: md` 下安全使用。

`viewer.go`（report 阅读器，299 行）是这里唯一没有飞书对应物的部分 —— 如果只想要「终端里快速翻 report」，那部分可以单独抽出来。
