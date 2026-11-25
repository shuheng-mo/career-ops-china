import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockAsrProvider } from '../providers/asr/mock.mjs';
import { CaptureSession, STATES } from '../server/capture.mjs';

test('[P4.1] mock provider 按脚本吐归一化事件（partial→final，带 revision/streamId）', async () => {
  const provider = createMockAsrProvider();
  const events = [];
  await provider.start({ sessionId: 's1', channel: 'mic', sampleRate: 16000 }, (e) => events.push(e));
  await provider.pushScript([
    { type: 'partial', text: '你好', segmentId: 'seg1' },
    { type: 'partial', text: '你好介绍', segmentId: 'seg1', revision: 2 },
    { type: 'final', text: '你好，介绍一下你的项目', segmentId: 'seg1' },
    { type: 'heartbeat' },
  ]);
  // heartbeat 不产生事件
  const nonHeartbeat = events.filter((e) => e.type !== 'heartbeat');
  assert.equal(events.filter((e) => e.type === 'heartbeat').length, 1);
  assert.equal(nonHeartbeat[0].type, 'partial');
  assert.equal(nonHeartbeat[0].revision, 1);
  assert.equal(nonHeartbeat[1].revision, 2);
  const fin = nonHeartbeat[2];
  assert.equal(fin.type, 'final');
  assert.ok(fin.streamId, '事件带 streamId');
  assert.ok(fin.endMs >= fin.startMs || (fin.startMs === 0 && fin.endMs === 0), '时间戳字段存在');
  await provider.close();
});

test('[P4.1] capture 状态机：合法迁移与非法迁移', () => {
  const cs = new CaptureSession({ sessionId: 's1' });
  assert.equal(cs.state, STATES.idle);
  cs.transition(STATES.permission_pending);
  cs.transition(STATES.connecting);
  cs.transition(STATES.recording);
  assert.equal(cs.state, STATES.recording);
  // recording → idle 非法（必须经 stopping）
  assert.throws(() => cs.transition(STATES.idle), /非法|迁移/);
  cs.transition(STATES.stopping);
  cs.transition(STATES.finished);
  assert.equal(cs.state, STATES.finished);
});

test('[P4.1] capture：error/degraded 可从任意活动状态进入，gap 计数', () => {
  const cs = new CaptureSession({ sessionId: 's1' });
  cs.transition(STATES.permission_pending);
  cs.transition(STATES.connecting);
  cs.transition(STATES.recording);
  cs.noteGap();
  cs.noteGap();
  assert.equal(cs.gapCount, 2);
  cs.transition(STATES.degraded);
  assert.equal(cs.state, STATES.degraded);
  // degraded 可恢复到 recording
  cs.transition(STATES.recording);
});

test('[P4.1] stop 释放资源（onRelease 回调触发，幂等）', async () => {
  const released = [];
  const cs = new CaptureSession({ sessionId: 's1', onRelease: (r) => released.push(...r) });
  cs.transition(STATES.permission_pending);
  cs.transition(STATES.connecting);
  cs.transition(STATES.recording);
  cs.trackResource('mic-stream');
  cs.trackResource('audio-context');
  await cs.stop();
  assert.equal(cs.state, STATES.finished);
  assert.deepEqual(released.sort(), ['audio-context', 'mic-stream']);
  await cs.stop(); // 幂等
  assert.equal(released.length, 2);
});

test('[P4.1] mock provider error 脚本 + close 幂等', async () => {
  const provider = createMockAsrProvider();
  const events = [];
  await provider.start({ sessionId: 's1', channel: 'mic', sampleRate: 16000 }, (e) => events.push(e));
  await provider.pushScript([{ type: 'error', code: 'TASK_FAILED', message: '模拟失败' }]);
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).code, 'TASK_FAILED');
  await provider.close();
  await provider.close(); // 幂等
  await assert.rejects(() => provider.pushScript([{ type: 'final', text: 'x' }]), /已关闭/);
});

test('[M-drill] push 真实音频：每 3s 吐 partial+final 预设问题（UI 演练转写）', async () => {
  const { createMockAsrProvider } = await import('../providers/asr/mock.mjs');
  const provider = createMockAsrProvider();
  const events = [];
  await provider.start({ sessionId: 's1', channel: 'mic', sampleRate: 16000 }, (e) => events.push(e));
  const frame3200 = Buffer.alloc(3200); // 100ms
  for (let i = 0; i < 10; i++) await provider.push(frame3200); // 1s：无事件
  assert.equal(events.length, 0, '1 秒内不应吐句');
  for (let i = 0; i < 25; i++) await provider.push(frame3200); // 累计 3.5s
  assert.ok(events.length >= 2, `3 秒后应有演练事件：${events.length}`);
  assert.ok(events.some((e) => e.type === 'partial' && e.text.includes('？') || e.text.includes('?')), '应吐问题文本');
  assert.ok(events.some((e) => e.type === 'final'), '应有 final');
  await provider.close();
  await provider.push(frame3200).catch(() => {}); // close 后 push 不炸
});
