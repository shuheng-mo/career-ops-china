// CaptureSession（spec §9.1）：采集状态机 + 资源追踪 + gap 计数。
// 状态：idle → permission_pending → connecting → recording → stopping → finished；
// error / degraded 可从任意活动状态进入；degraded 可恢复 recording。
import { createHash } from 'node:crypto';

export const STATES = {
  idle: 'idle',
  permission_pending: 'permission_pending',
  connecting: 'connecting',
  recording: 'recording',
  stopping: 'stopping',
  finished: 'finished',
  error: 'error',
  degraded: 'degraded',
};

const ACTIVE = new Set([STATES.permission_pending, STATES.connecting, STATES.recording, STATES.stopping, STATES.degraded]);
const LEGAL = {
  [STATES.idle]: [STATES.permission_pending, STATES.connecting],
  [STATES.permission_pending]: [STATES.connecting, STATES.error, STATES.finished],
  [STATES.connecting]: [STATES.recording, STATES.error, STATES.degraded],
  [STATES.recording]: [STATES.stopping, STATES.error, STATES.degraded],
  [STATES.degraded]: [STATES.recording, STATES.stopping, STATES.error],
  [STATES.stopping]: [STATES.finished, STATES.error],
  [STATES.error]: [], // 终态：重启 = 新 CaptureSession
  [STATES.finished]: [],
};

export class CaptureSession {
  constructor({ sessionId, onRelease, budget } = {}) {
    this.sessionId = sessionId || `cap-${createHash('sha256').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 12)}`;
    this.state = STATES.idle;
    this.gapCount = 0;
    this.resources = [];
    this.onRelease = onRelease || (() => {});
    this.stopped = false;
    // 成本闸门（spec §9.3）：默认 90 分钟/场、云 ASR 预算 3 元（按 sent_audio_ms 估算，cnyPerHour 按官方计价）
    this.budget = {
      maxSessionMinutes: budget?.maxSessionMinutes ?? 90,
      budgetYuan: budget?.budgetYuan ?? 3,
      cnyPerHour: budget?.cnyPerHour ?? 1.188,
      // nowShiftMs：测试注入（负值 = 会话提前 N ms 开始），生产恒 0
      startAt: Date.now() + (budget?.nowShiftMs || 0),
    };
    this.sentAudioMs = 0;
    this.budgetExceeded = false;
  }

  // 推音频时记账；到限返回 true 并标记（调用方停止云调用）
  noteAudioMs(ms) {
    this.sentAudioMs += ms;
    const minutes = (Date.now() - this.budget.startAt) / 60000;
    const yuan = (this.sentAudioMs / 3600000) * this.budget.cnyPerHour;
    if (minutes >= this.budget.maxSessionMinutes || yuan >= this.budget.budgetYuan) {
      this.budgetExceeded = true;
    }
    return this.budgetExceeded;
  }

  transition(next) {
    const allowed = LEGAL[this.state] || [];
    if (!allowed.includes(next)) {
      throw new Error(`非法状态迁移：${this.state} → ${next}（允许：${allowed.join(', ') || '无'}）`);
    }
    this.state = next;
    return this.state;
  }

  noteGap() {
    if (!ACTIVE.has(this.state)) throw new Error(`非活动状态不能记 gap（当前 ${this.state}）`);
    this.gapCount += 1;
    return this.gapCount;
  }

  trackResource(name) {
    this.resources.push(name);
  }

  async stop() {
    if (this.stopped) return this.resources; // 幂等：资源只释放一次
    if (this.state !== STATES.finished && this.state !== STATES.error) {
      // 未显式走 stopping 的，直接补齐到 finished（用户可随时停止）
      if (this.state !== STATES.stopping && ACTIVE.has(this.state)) this.transition(STATES.stopping);
      this.transition(STATES.finished);
    }
    this.stopped = true;
    this.onRelease(this.resources);
    this.resources = [];
    return [];
  }
}
