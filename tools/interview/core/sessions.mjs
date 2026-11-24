import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveRoot, atomicWriteJson, appendJsonl, readJsonlSafe, withLock } from './storage.mjs';
import { readManifest } from './blocks.mjs';
import { assertValid, ValidationError } from './validation.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sessionDir(root, sessionId) {
  if (!UUID_RE.test(String(sessionId))) {
    throw new ValidationError(`非法 session id（必须是 uuid）：${sessionId}`);
  }
  const { paths } = resolveRoot(root);
  return join(paths.sessionsDir, sessionId);
}

export function currentKbRevision(root) {
  const { paths } = resolveRoot(root);
  const manifestFile = join(paths.versionsDir, 'manifest.json');
  if (!existsSync(manifestFile)) return 'empty';
  return `sha256:${hashFile(manifestFile)}`;
}
function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
}

export function createSession(root, {
  mode = 'historical_import', source = 'import', applicationNum = null,
  round = null, track = null, sourceText = null,
} = {}) {
  const { paths } = resolveRoot(root);
  const sessionId = randomUUID();
  const session = {
    schema_version: 1,
    session_id: sessionId,
    mode,
    application_num: applicationNum,
    round,
    track,
    pack_id: null,
    kb_revision: currentKbRevision(root),
    created_at: new Date().toISOString(),
    source,
    consent: { recording: false, cloud_audio: false, cloud_text: false },
    status: 'created',
  };
  if (sourceText !== null && sourceText !== undefined) {
    session.source_hash = createHash('sha256').update(sourceText).digest('hex');
  }
  assertValid('session', session);
  const dir = join(paths.sessionsDir, sessionId);
  mkdirSync(dir, { recursive: true });
  atomicWriteJson(join(dir, 'session.json'), session);
  // events.jsonl 首事件
  appendEvent(root, sessionId, { type: 'session.created', payload: { mode, source } });
  return session;
}

export function getSession(root, sessionId) {
  const f = join(sessionDir(root, sessionId), 'session.json');
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, 'utf8'));
}

export function listSessions(root) {
  const { paths } = resolveRoot(root);
  if (!existsSync(paths.sessionsDir)) return [];
  return readdirSync(paths.sessionsDir)
    .filter((d) => existsSync(join(paths.sessionsDir, d, 'session.json')))
    .sort()
    .map((d) => JSON.parse(readFileSync(join(paths.sessionsDir, d, 'session.json'), 'utf8')));
}

export function appendEvent(root, sessionId, { type, payload = {} }) {
  const dir = sessionDir(root, sessionId);
  if (!existsSync(join(dir, 'session.json'))) {
    throw new Error(`session 不存在：${sessionId}`);
  }
  const eventsFile = join(dir, 'events.jsonl');
  return withLock(eventsFile, () => {
    const { rows } = readJsonlSafe(eventsFile);
    const seq = rows.length ? rows[rows.length - 1].seq + 1 : 1;
    const event = {
      event_id: randomUUID(),
      session_id: sessionId,
      seq,
      type,
      at: new Date().toISOString(),
      payload,
      schema_version: 1,
    };
    assertValid('event', event);
    appendJsonl(eventsFile, event);
    return event;
  });
}

export function readEvents(root, sessionId) {
  return readJsonlSafe(join(sessionDir(root, sessionId), 'events.jsonl')).rows;
}

export function recoverEvents(root, sessionId) {
  const eventsFile = join(sessionDir(root, sessionId), 'events.jsonl');
  if (!existsSync(eventsFile)) return { recovered: 0 };
  const { rows, recovered } = readJsonlSafe(eventsFile);
  if (!recovered) return { recovered: 0 };
  writeFileSync(eventsFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  appendJsonl(eventsFile, {
    event_id: randomUUID(),
    session_id: sessionId,
    seq: rows.length ? rows[rows.length - 1].seq + 1 : 1,
    type: 'recovery',
    at: new Date().toISOString(),
    payload: { dropped: recovered },
    schema_version: 1,
  });
  return { recovered };
}

export function findSessionByImport(root, { sourceText, applicationNum = null, round = null }) {
  const hash = createHash('sha256').update(sourceText).digest('hex');
  for (const s of listSessions(root)) {
    if (s.source_hash === hash
      && (s.application_num ?? null) === (applicationNum ?? null)
      && (s.round ?? null) === (round ?? null)) {
      return s.session_id;
    }
  }
  return null;
}

export function saveUtterances(root, sessionId, utterances) {
  for (const u of utterances) assertValid('utterance', u);
  atomicWriteJson(join(sessionDir(root, sessionId), 'utterances.json'), { schema_version: 1, utterances });
}

export function readUtterances(root, sessionId) {
  const f = join(sessionDir(root, sessionId), 'utterances.json');
  if (!existsSync(f)) return [];
  return JSON.parse(readFileSync(f, 'utf8')).utterances;
}

export function saveQuestions(root, sessionId, questions) {
  atomicWriteJson(join(sessionDir(root, sessionId), 'questions.json'), { schema_version: 1, questions });
}

export function readQuestions(root, sessionId) {
  const f = join(sessionDir(root, sessionId), 'questions.json');
  if (!existsSync(f)) return [];
  return JSON.parse(readFileSync(f, 'utf8')).questions;
}
