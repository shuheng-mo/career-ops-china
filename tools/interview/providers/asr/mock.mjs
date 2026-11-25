// Mock ASR provider（spec §12 P4.1）：脚本化 partial/final/heartbeat/error/gap/reconnect。
// 用于 P4.2-4.5 全链测试与 UI 演练，不访问任何网络。
function nowMs() { return Date.now(); }

const DRILL_QUESTIONS = [
  '请先做一下自我介绍？',
  '你在最近的项目里负责哪一部分？',
  '这个系统的数据链路是怎么设计的？',
  '遇到过什么线上问题，当时怎么排查的？',
  '为什么选择这个技术方案，对比过哪些替代？',
];

export function createMockAsrProvider() {
  let emit = null;
  let streamId = null;
  let closed = false;
  let clock = 0; // 模拟音频时间轴（ms）
  let spoken = 0; // 已吐句数（UI 演练：每 3s 音频一句）

  const makeEvent = (base) => ({
    provider: 'mock',
    streamId,
    channel: 'mic',
    startMs: clock,
    endMs: clock,
    ...base,
  });

  return {
    id: 'mock',
    capabilities() {
      return { streaming: true, hotwords: false, diarization: false, timestamps: true };
    },
    async probe() {
      return { ok: true, reason: 'mock provider 恒可用' };
    },
    async start({ channel = 'mic' }, emitFn) {
      if (closed) throw new Error('provider 已关闭');
      emit = emitFn;
      streamId = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      clock = 0;
      void channel;
    },
    // 推脚本（而非真实音频）：逐条吐归一化事件
    async pushScript(script) {
      if (closed) throw new Error('provider 已关闭，无法继续推流');
      for (const step of script) {
        if (step.type === 'heartbeat') {
          emit(makeEvent({ type: 'heartbeat', segmentId: 'hb', revision: 0 }));
          continue;
        }
        if (step.durationMs) clock += step.durationMs;
        emit(makeEvent({
          type: step.type,
          segmentId: step.segmentId || 'seg',
          revision: step.revision || 1,
          text: step.text || '',
          code: step.code,
          message: step.message,
        }));
      }
    },
    // 真实音频接口（mock 不解码，仅记账）；UI 演练模式下每攒 3s 吐一句预设问题，
    // 让语音采集链路有真实转写体验（partial→final，问句还会触发实时提词）
    async push(pcm) {
      if (closed) throw new Error('provider 已关闭');
      clock += Math.round((pcm.length / 2 / 16000) * 1000);
      const idx = Math.floor(clock / 3000);
      if (idx > spoken) {
        spoken = idx;
        const text = DRILL_QUESTIONS[(idx - 1) % DRILL_QUESTIONS.length];
        emit?.(makeEvent({ type: 'partial', segmentId: `drill-${idx}`, revision: 1, text }));
        emit?.(makeEvent({ type: 'final', segmentId: `drill-${idx}`, revision: 2, text }));
      }
    },
    async finish() { /* 无缓冲 */ },
    async close() {
      if (closed) return; // 幂等
      closed = true;
      emit = null;
    },
    isClosed: () => closed,
  };
}
