import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSession, appendEvent, readEvents } from '../core/sessions.mjs';
import { resolveRoot } from '../core/storage.mjs';
import { appendSignal, readSignals } from '../core/signals.mjs';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'ib-jsonl-'));
}

test('[I3] 尾部半行后 appendEvent：半行被截断、新事件完整落盘', () => {
  const t = tmpRoot();
  const s = createSession(t, { mode: 'historical_import', source: 'fixture' });
  appendEvent(t, s.session_id, { type: 'segment.final', payload: {} });
  const eventsFile = join(t, 'sessions', s.session_id, 'events.jsonl');
  // 模拟崩溃残留：追加一条半行
  writeFileSync(eventsFile, readFileSync(eventsFile, 'utf8') + '{"event_id":"half","seq":99,"trun');
  appendEvent(t, s.session_id, { type: 'question.detected', payload: { q: 'after-crash' } });
  const events = readEvents(t, s.session_id);
  assert.equal(events.length, 3); // created + segment.final + 新事件（半行被截断丢弃）
  const last = events.at(-1);
  assert.equal(last.type, 'question.detected');
  assert.equal(last.seq, 3);
  // 文件每一行都是完整 JSON
  for (const line of readFileSync(eventsFile, 'utf8').trim().split('\n')) {
    assert.doesNotThrow(() => JSON.parse(line), line.slice(0, 60));
  }
});

test('[I3] 尾部半行后 appendSignal：同样自愈', () => {
  const t = tmpRoot();
  mkdirSync(join(t, 'knowledge'), { recursive: true });
  const { paths } = resolveRoot(t);
  const sigFile = paths.signalsFile;
  writeFileSync(sigFile, '{"signal_id":"' + 'a'.repeat(16) + '","kind":"predi'); // 半行
  const r = appendSignal(t, { kind: 'predicted', source_kind: 'manual', source_ref: 'x', intent_key: 'm.x' });
  assert.equal(r.deduped, false);
  const signals = readSignals(t);
  assert.equal(signals.length, 1); // 半行丢弃，新信号完整
  assert.equal(signals[0].kind, 'predicted');
});
