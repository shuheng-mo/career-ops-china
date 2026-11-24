import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTranscript } from '../review/normalize.mjs';
import { createSession, appendEvent, recoverEvents, getSession, readEvents, findSessionByImport } from '../core/sessions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');
const MD_FIXTURE = join(HERE, 'fixtures', 'transcript-fixture.md');
const SRT_FIXTURE = join(HERE, 'fixtures', 'transcript-fixture.srt');

function runCli(args) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function preparedRoot() {
  const t = mkdtempSync(join(tmpdir(), 'ib-tx-'));
  runCli(['init', '--root', t]);
  return t;
}

test('normalizeTranscript MD：无标签全部 unknown，寒暄保留，不编造时间戳', () => {
  const text = readFileSync(MD_FIXTURE, 'utf8');
  const uts = normalizeTranscript(text, 'md');
  assert.ok(uts.length >= 6, `实际 ${uts.length} 条`);
  assert.ok(uts.every((u) => u.role === 'unknown'), '无标签不得推断角色');
  assert.ok(uts.every((u) => u.start_ms === null && u.end_ms === null));
  assert.ok(uts.some((u) => u.raw_text.includes('你好')));
  assert.ok(uts.every((u) => /^u\d{3}$/.test(u.id)));
  assert.ok(uts.every((u) => u.source_span && u.source_span.line_start >= 1));
});

test('normalizeTranscript 显式标签可识别（不按问号推断）', () => {
  const uts = normalizeTranscript('面试官：介绍一下项目\n候选人：好的，虚构项目\n没有标签的一句', 'md');
  assert.equal(uts[0].role, 'interviewer');
  assert.equal(uts[1].role, 'candidate');
  assert.equal(uts[2].role, 'unknown');
});

test('normalizeTranscript SRT：时间戳解析为 ms', () => {
  const text = readFileSync(SRT_FIXTURE, 'utf8');
  const uts = normalizeTranscript(text, 'srt');
  assert.equal(uts.length, 3);
  assert.equal(uts[0].start_ms, 1000);
  assert.equal(uts[0].end_ms, 4000);
});

test('transcript import：建 session + events，重复导入复用', () => {
  const t = preparedRoot();
  let r = runCli(['transcript', 'import', '--file', MD_FIXTURE, '--application', '753', '--round', '一面', '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const j1 = JSON.parse(r.out);
  assert.ok(j1.session_id);
  assert.equal(j1.reused, false);
  const sess = getSession(t, j1.session_id);
  assert.equal(sess.application_num, 753);
  assert.equal(sess.mode, 'historical_import');
  assert.ok(sess.kb_revision);
  assert.equal(sess.consent.cloud_audio, false);
  // utterances 落盘
  assert.ok(existsSync(join(t, 'sessions', j1.session_id, 'utterances.json')));
  // events 有 session.created
  const events = readEvents(t, j1.session_id);
  assert.equal(events[0].type, 'session.created');
  assert.equal(events[0].seq, 1);
  // 重复导入 → reuse
  r = runCli(['transcript', 'import', '--file', MD_FIXTURE, '--application', '753', '--round', '一面', '--root', t, '--json']);
  const j2 = JSON.parse(r.out);
  assert.equal(j2.reused, true);
  assert.equal(j2.session_id, j1.session_id);
  const sessionCount = readdirSync(join(t, 'sessions')).filter((d) => existsSync(join(t, 'sessions', d, 'session.json'))).length;
  assert.equal(sessionCount, 1);
});

test('--round 不在白名单 → exit 2', () => {
  const t = preparedRoot();
  const r = runCli(['transcript', 'import', '--file', MD_FIXTURE, '--application', '753', '--round', '五面', '--root', t]);
  assert.equal(r.code, 2);
  assert.match(r.out, /round|轮次|一面/);
});

test('appendEvent seq 单调；不存在的 session → 报中文错', () => {
  const t = preparedRoot();
  const s = createSession(t, { mode: 'historical_import', source: 'fixture' });
  appendEvent(t, s.session_id, { type: 'question.detected', payload: { q: 1 } });
  appendEvent(t, s.session_id, { type: 'question.detected', payload: { q: 2 } });
  const events = readEvents(t, s.session_id);
  // session.created 占 seq 1，后续事件从 2 起单调递增
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  assert.equal(events[0].type, 'session.created');
  assert.throws(() => appendEvent(t, 'no-such-session', { type: 'question.detected', payload: {} }), /不存在|非法/);
});

test('崩溃恢复：尾部半行被丢弃并记 recovery 事件', () => {
  const t = preparedRoot();
  const s = createSession(t, { mode: 'historical_import', source: 'fixture' });
  appendEvent(t, s.session_id, { type: 'segment.final', payload: {} });
  const eventsFile = join(t, 'sessions', s.session_id, 'events.jsonl');
  writeFileSync(eventsFile, readFileSync(eventsFile, 'utf8') + '{"event_id":"x","seq":99,"trunc');
  const r = recoverEvents(t, s.session_id);
  assert.equal(r.recovered, 1);
  const events = readEvents(t, s.session_id);
  assert.equal(events.filter((e) => e.type === 'segment.final').length, 1);
  assert.ok(events.some((e) => e.type === 'recovery'));
});

test('findSessionByImport 按 hash+num+round 复用', () => {
  const t = preparedRoot();
  const text = readFileSync(MD_FIXTURE, 'utf8');
  const s = createSession(t, {
    mode: 'historical_import', source: 'fixture', applicationNum: 753, round: '一面',
    sourceText: text,
  });
  const found = findSessionByImport(t, { sourceText: text, applicationNum: 753, round: '一面' });
  assert.equal(found, s.session_id);
  const notFound = findSessionByImport(t, { sourceText: text, applicationNum: 999, round: '一面' });
  assert.equal(notFound, null);
});
