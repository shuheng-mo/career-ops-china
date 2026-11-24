# Interview Studio Phase 4 实现计划（实时链路，除真实 ASR API 调用外全部实现）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（native，同前）。

**Goal:** 按 spec §9 + §12 P4 实现实时链路全部结构：Mock ASR adapter（脚本化 partial/final/heartbeat/error/gap/reconnect）、百炼 Fun-ASR-Realtime WS adapter（协议完整实现，协议正确性用本地 stub WS server 验证——**不调真实 API**）、sherpa-local 动态加载 + manifest + doctor、Fast/Slow path（问题识别/防抖/锁定/过时丢弃/同块不重跳）、浏览器 AudioWorklet 采集 + 练习页实时模式。真实 Key/网络/模型的 smoke test 与 P4.5 对照实验留给用户验收。

**Architecture:** `providers/asr/`（interface + mock + aliyun-fun-asr + sherpa-local 动态加载）、`tools/interview/server/capture.mjs`（Fast/Slow path 状态机，复用 P3 practice 模式闸门与 events）、server 增加 WS 端点（`ws` 库，spec §3.1 授权的新依赖）、UI 增加实时练习模式（AudioWorklet 16k mono s16le 采集 + live 提词面板）。

**Tech Stack:** 新增依赖仅 `ws` ^8（spec §3.1 明确授权）；其余同前。

**Spec:** §3.2（AsrProvider 接口与百炼协议）、§9（Capture/Fast-Slow/可靠性成本）、§12 P4。

## Global Constraints（P4 增量）

- 默认 `asr.provider: none`；云端连接前必须显示目标服务/费用/数据去向（UI 层），用户主动选择才连
- partial 只做预览/预检索，不提交事实、不计数；仅 final 提交
- 发送缓冲上限默认 2 秒音频，超限记 gap 事件；WS 超时 10s / finish flush 5s；有限重连默认 2 次；重连用新 streamId
- 同 block 不重复跳；新问题取消旧任务（generation token）；用户锁定禁止自动跳；候选人回答不触发；600ms 最小跳转间隔 + 2000ms 稳定期
- 双通道（mic/remote）分别计费与标记；speaker cluster ≠ 用户/面试官身份，需人工确认
- API Key 只在本地 server 进程，浏览器永远拿不到；Key 不写日志
- provider 失败 → 明确提示 → 降级文本/手动模式，不静默换云商

## Review Focus

1. 重连后 final 只提交一次（新 streamId 旧段不重复计数）
2. 发送缓冲超限 → capture.gap 事件，不无限积压内存
3. 盲测模式下实时定位结果不出现（P3 纪律在实时链路延续）
4. 锁定后自动跳被禁止；过时请求（旧 generation token）结果被丢弃
5. 资源释放：stop 后 MediaStream/AudioContext/WS 全释放（UI 侧代码审查 + server 侧 capture 关闭）

---

### Task 1: AsrProvider 接口 + Mock provider + capture 状态机

**Files:** Create `providers/asr/interface.mjs`（AsrProvider 契约 + 事件归一化）、`providers/asr/mock.mjs`（脚本化 partial/final/heartbeat/error/gap/reconnect）、`server/capture.mjs`（CaptureSession 状态机：idle→connecting→recording→stopping→finished + error/degraded）、Test `asr-mock.test.mjs`

- [ ] RED→GREEN：mock 按脚本吐事件；capture 状态机非法迁移拒绝；stop 后资源释放回调触发；gap 计数
- [ ] commit

### Task 2: 百炼 Fun-ASR-Realtime WS adapter（协议实现，本地 stub 验证）

**Files:** Create `providers/asr/aliyun-fun-asr.mjs`（run-task/task-started/binary PCM/finish-task/task-finished/result-generated 映射 sentence_id/begin_time/end_time/text/sentence_end；heartbeat 忽略；Authorization Bearer；hotwords/vocabulary_id 透传；10s 超时/5s flush/2 次重连新 streamId）、Test `asr-aliyun.test.mjs`（本地 ws stub server 按协议应答，全离线）

- [ ] RED→GREEN：task-started 前不发音频；result-generated 映射 partial/final（sentence_end）；task-failed → error 事件含 code；heartbeat 不产生事件；finish flush 5s 超时强制 close；重连计数 2 次后 error
- [ ] commit

### Task 3: sherpa-local 动态 provider + doctor

**Files:** Create `providers/asr/sherpa-local.mjs`（动态 import 'sherpa-onnx-node'，缺模块/模型 → probe 失败中文提示；模型 manifest JSON：path/sha256/来源/许可）、Modify doctor（asr 检查：provider 配置存在性、模块可加载性、模型 manifest 校验）、Test `asr-sherpa.test.mjs`（模块缺失路径离线可测）

- [ ] RED→GREEN：未安装模块 → probe {ok:false, reason 中文}，不影响其他功能；manifest 缺字段拒绝
- [ ] commit

### Task 4: Fast/Slow path（问题识别 → 检索 → 模式闸门 → 防抖/锁定/过时丢弃）

**Files:** Modify `server/capture.mjs`、Test `capture-fastpath.test.mjs`

**Interfaces:** CaptureSession.onAsrEvent → final 文本规则识别问题（？/?/什么/怎么/为什么/多少/哪 + 候选人不触发：需 speaker=mic 确认或 manual）→ 检索（复用 P1）→ generation token → 2000ms 稳定期提交 → 按 practice 模式闸门（盲测不显示）→ 事件落盘（question.detected 带 realtime 标记）；锁定开关；同 block 600ms 内不重跳

- [ ] RED→GREEN：partial 不产生定位；候选人回答不触发；锁定后无自动跳；旧 token 结果丢弃；同块防抖；盲测模式不回传块
- [ ] commit

### Task 5: server WS 端点 + practice 集成

**Files:** Modify server.mjs（`ws` Upgrade /ws/capture?token=，Origin/Host 校验同 HTTP）、Modify api（practice start 带 asr provider 选择）、Test `server-ws.test.mjs`（ws client e2e：token 鉴权 → mock provider 启动 → push 音频帧 → 收 partial/final → 定位事件）

- [ ] RED→GREEN：无 token WS 拒绝；push base16k PCM → mock final → fast path 事件；provider error → 客户端收 error + 降级提示
- [ ] commit

### Task 6: UI 实时练习模式（AudioWorklet 采集 + live 面板）

**Files:** `apps/interview-studio/worklet.js`（16k 重采样 mono s16le 100-200ms 帧）、app.js 练习页增加「语音模式」（getUserMedia 授权 → WS 采集 → live 转写显示 → 按模式显示提词/锚点/盲测面板 → 锁定/停止按钮 → 状态机展示）、Test 扩展 smoke（worklet 语法 grep：sampleRate/16000/charLength；无外链）

- [ ] RED→GREEN（smoke + 既有回归）
- [ ] commit

### Task 7: docs + 终审

- [ ] INTERVIEW-STUDIO.md（ASR 设置/费用表/隐私边界/降级矩阵：云端未配 Key 时全部功能可用性说明）、ADR、全量回归、外部 reviewer 终审（WS/采集/成本闸门）
- [ ] 通知用户配 API Key 验收（P4.2 smoke + P4.5 对照实验）

### 验收边界（留给用户）

- 真实百炼 Key：fun-asr-realtime 连通性、热词、费用计量读数
- sherpa：模块安装 + 模型下载 + 真实识别质量
- P4.5：同授权中文技术面试片段 local vs 云端 CER/延迟/成本对照
