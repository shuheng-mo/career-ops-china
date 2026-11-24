// Mock ASR provider（spec §12 P4.1）：脚本化 partial/final/heartbeat/error/gap/reconnect。
// 用于 P4.2-4.5 全链测试与 UI 演练，不访问任何网络。
function nowMs() { return Date.now(); }

export function createMockAsrProvider() {
  let emit = null;
  let streamId = null;
  let closed = false;
  let clock = 0; // 模拟音频时间轴（ms）

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
    // 真实音频接口（mock 不解码，仅记账）
    async push(pcm) {
      if (closed) throw new Error('provider 已关闭');
      clock += Math.round((pcm.length / 2 / 16000) * 1000);
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
