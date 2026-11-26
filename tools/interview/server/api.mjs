// Studio JSON API（P3 Task 2-4）：薄封装 core 层。安全边界：
// - 路径类 id（session/pack/block_id）先经 core 校验（uuid/12hex/slug），非法 → 400
// - 盲测未揭示前不返回任何块内容/候选文本（spec §8）
// - 写操作全部走 core 的校验+原子写，server 不直接碰文件
import http from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRoot } from '../core/storage.mjs';
import { ValidationError } from '../core/validation.mjs';
import { readBlocks, readBlockById, writeBlock } from '../core/blocks.mjs';
import { buildIndex, search } from '../retrieval/bm25.mjs';
import { decide, autoThresholdFor } from '../retrieval/rank.mjs';
import { runSearch } from './retrieval-service.mjs';

import { computeStats } from '../core/stats.mjs';
import { loadBootstrap, listSeeds } from '../core/bootstrap.mjs';
import { createSession, getSession, listSessions, readUtterances, readQuestions, saveQuestions, saveUtterances, appendEvent, readEvents } from '../core/sessions.mjs';
import { readPack } from '../packs/render.mjs';

const BLIND_MODES = ['mock_blind'];
const ANCHOR_MODES = ['mock_anchor'];
const PRACTICE_MODES = ['mock_assisted', 'mock_anchor', 'mock_blind', 'real_record_only'];

// Practice 服务端内存态：question_ref → {blockId, revealed, candidateIds}（单用户本地，重启即清）
const practiceState = new Map();
const sessionMode = new Map();

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new ValidationError('请求体超过 1MB 限制'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  return JSON.parse(await readBody(req));
}

export function registerCoreApi(root) {
  return async ({ req, res, url }) => {
    const path = url.pathname;
    const m = req.method;

    try {
      // ---------- 知识库 ----------
      if (path === '/api/blocks' && m === 'GET') {
        const blocks = readBlocks(root, { all: true }).map((b) => ({
          block_id: b.block_id, revision: b.frontMatter.revision, kind: b.frontMatter.kind,
          status: b.frontMatter.status, tracks: b.frontMatter.tracks,
          criticality: b.frontMatter.criticality, questions: b.frontMatter.questions,
          anchors: b.frontMatter.anchors, body: b.body,
        }));
        return json(res, 200, { ok: true, blocks });
      }
      let mm = path.match(/^\/api\/blocks\/([^/]+)$/);
      if (mm && m === 'GET') {
        const blk = readBlockById(root, decodeURIComponent(mm[1]));
        if (!blk) return json(res, 404, { ok: false, message: '块不存在' });
        return json(res, 200, { ok: true, ...blk });
      }
      if (mm && m === 'POST') {
        const payload = await readJsonBody(req);
        const { frontMatter, body } = payload;
        if (!frontMatter || typeof body !== 'string') return json(res, 400, { ok: false, message: '需要 {frontMatter, body}' });
        frontMatter.block_id = decodeURIComponent(mm[1]);
        const { revision } = writeBlock(root, frontMatter, body);
        return json(res, 200, { ok: true, revision });
      }

      // ---------- 检索 ----------
      if (path === '/api/search' && m === 'GET') {
        const q = url.searchParams.get('q') || '';
        if (!q.trim()) return json(res, 400, { ok: false, message: '缺少 q' });
        const { results, threshold } = await runSearch(root, q, { topK: 5 });
        const decision = decide(q, results, { autoThreshold: threshold, mode });
        let block = null;
        if (decision === 'hit') {
          const blk = readBlockById(root, results[0].blockId);
          block = blk ? { block_id: blk.block_id, frontMatter: blk.frontMatter, body: blk.body } : null;
        }
        return json(res, 200, {
          ok: true, decision,
          results: results.map((r) => ({ blockId: r.blockId, score: r.score })),
          block, // 仅 decision=hit 时非空；candidates 不带正文
        });
      }

      // ---------- 统计 / bootstrap / 种子 ----------
      if (path === '/api/stats' && m === 'GET') {
        const track = url.searchParams.get('track') || undefined;
        return json(res, 200, { ok: true, ...computeStats(root, { track }) });
      }
      if (path === '/api/bootstrap' && m === 'GET') {
        const st = loadBootstrap(root);
        const seeds = listSeeds(root);
        return json(res, 200, { ok: true, ...st, seeds: seeds.map((s) => ({ seed_id: s.seed_id, intent_key: s.intent_key, question: s.question, status: s.status, missing_fields: s.missing_fields })) });
      }
      if (path === '/api/seeds' && m === 'GET') {
        return json(res, 200, { ok: true, seeds: listSeeds(root) });
      }

      // ---------- packs ----------
      if (path === '/api/packs' && m === 'GET') {
        const { paths } = resolveRoot(root);
        const packs = existsSync(paths.packsDir)
          ? readdirSync(paths.packsDir)
            .filter((d) => /^pack-[a-f0-9]{12}$/.test(d) && existsSync(join(paths.packsDir, d, 'pack.json')))
            .map((d) => JSON.parse(readFileSync(join(paths.packsDir, d, 'pack.json'), 'utf8')))
          : [];
        return json(res, 200, { ok: true, packs });
      }
      mm = path.match(/^\/api\/packs\/([^/]+)$/);
      if (mm && m === 'GET') {
        const pack = readPack(root, mm[1]);
        const { renderPack } = await import('../packs/render.mjs');
        const md = renderPack(root, pack.pack_id);
        return json(res, 200, { ok: true, pack, markdown: md });
      }

      // ---------- practice ----------
      if (path === '/api/practice/start' && m === 'POST') {
        const body = await readJsonBody(req);
        const mode = body.mode;
        if (!PRACTICE_MODES.includes(mode)) {
          return json(res, 400, { ok: false, message: `mode 必须是 ${PRACTICE_MODES.join('/')}` });
        }
        const s = createSession(root, { mode, source: 'studio-practice' });
        sessionMode.set(s.session_id, mode);
        return json(res, 200, { ok: true, session_id: s.session_id, mode });
      }
      mm = path.match(/^\/api\/practice\/([^/]+)\/question$/);
      if (mm && m === 'POST') {
        const sid = mm[1];
        const sess = getSession(root, sid);
        if (!sess) return json(res, 404, { ok: false, message: 'session 不存在' });
        const mode = sessionMode.get(sid) || sess.mode;
        const body = await readJsonBody(req);
        const q = String(body.text || '').trim();
        if (!q) return json(res, 400, { ok: false, message: '缺少 text' });
        if (mode === 'real_record_only') {
          // 真实记录模式：不检索不定位，仅登记
          const ref = `pq-${randomUUID().slice(0, 8)}`;
          appendEvent(root, sid, { type: 'question.detected', payload: { question_ref: ref, record_only: true } });
          return json(res, 200, { ok: true, question_ref: ref, record_only: true });
        }
        const { results, threshold } = await runSearch(root, q, { topK: 5 });
        const decision = decide(q, results, { autoThreshold: threshold, mode });
        const questionRef = `pq-${randomUUID().slice(0, 8)}`;
        const top = results[0];
        if (BLIND_MODES.includes(mode)) {
          // 盲测：不泄漏命中与否/块信息；服务端记住，reveal 才给
          practiceState.set(`${sid}:${questionRef}`, { blockId: decision === 'hit' ? top.blockId : null, decision, revealed: false, topBlockId: top?.blockId || null });
          appendEvent(root, sid, { type: 'question.detected', payload: { question_ref: questionRef, mode, blind: true } });
          return json(res, 200, { ok: true, question_ref: questionRef, blind: true });
        }
        if (decision === 'hit' && top) {
          practiceState.set(`${sid}:${questionRef}`, { blockId: top.blockId, decision, revealed: false });
          appendEvent(root, sid, { type: 'question.detected', payload: { question_ref: questionRef, block: top.blockId } });
          const blk = readBlockById(root, top.blockId);
          if (ANCHOR_MODES.includes(mode)) {
            return json(res, 200, { ok: true, question_ref: questionRef, decision, block: { block_id: blk.block_id, anchors: blk.frontMatter.anchors, questions: blk.frontMatter.questions } });
          }
          return json(res, 200, { ok: true, question_ref: questionRef, decision, block: { block_id: blk.block_id, frontMatter: blk.frontMatter, body: blk.body } });
        }
        if (decision === 'candidates') {
          practiceState.set(`${sid}:${questionRef}`, { blockId: null, decision, revealed: false, candidateIds: results.map((r) => r.blockId) });
          appendEvent(root, sid, { type: 'question.detected', payload: { question_ref: questionRef, candidates: results.map((r) => r.blockId) } });
          return json(res, 200, { ok: true, question_ref: questionRef, decision, candidates: results.map((r) => ({ blockId: r.blockId, score: r.score })) });
        }
        return json(res, 200, { ok: true, question_ref: questionRef, decision: 'unknown' });
      }
      mm = path.match(/^\/api\/practice\/([^/]+)\/reveal$/);
      if (mm && m === 'POST') {
        const sid = mm[1];
        const body = await readJsonBody(req);
        const ref = body.question_ref;
        const state = practiceState.get(`${sid}:${ref}`);
        if (!state) return json(res, 404, { ok: false, message: 'question_ref 不存在（或 server 重启后内存态已清）' });
        if (!state.revealed) {
          state.revealed = true;
          appendEvent(root, sid, { type: 'hint.revealed', payload: { question_ref: ref, block: state.blockId || state.topBlockId || null } });
        }
        const blkId = state.blockId || state.topBlockId;
        const blk = blkId ? readBlockById(root, blkId) : null;
        return json(res, 200, {
          ok: true, revealed: true,
          block: blk ? { block_id: blk.block_id, frontMatter: blk.frontMatter, body: blk.body } : null,
          candidates: state.candidateIds || null,
        });
      }
      mm = path.match(/^\/api\/practice\/([^/]+)\/rate$/);
      if (mm && m === 'POST') {
        const sid = mm[1];
        const body = await readJsonBody(req);
        const score = body.score;
        if (!Number.isInteger(score) || score < 0 || score > 4) {
          return json(res, 400, { ok: false, message: 'score 必须是 0-4 整数' });
        }
        const ref = body.question_ref;
        const state = practiceState.get(`${sid}:${ref}`);
        if (!state) return json(res, 404, { ok: false, message: `question_ref 不存在：${ref}` });
        // revealed 以服务端揭示状态为准（spec §8：提示揭示是服务端保证，不信前端自报）
        const revealed = state.revealed;
        state.blockId = state.blockId || state.topBlockId || null;
        appendEvent(root, sid, { type: 'rating.self', payload: { question_ref: ref, score, revealed, block: state.blockId } });
        return json(res, 200, { ok: true });
      }
      mm = path.match(/^\/api\/practice\/([^/]+)\/finish$/);
      if (mm && m === 'POST') {
        appendEvent(root, mm[1], { type: 'session.finished', payload: {} });
        return json(res, 200, { ok: true });
      }

      // ---------- replay ----------
      if (path === '/api/sessions' && m === 'GET') {
        const sessions = listSessions(root).map((s) => ({
          session_id: s.session_id, mode: s.mode, round: s.round,
          application_num: s.application_num, created_at: s.created_at, retrospective: s.retrospective || false,
        }));
        return json(res, 200, { ok: true, sessions });
      }
      mm = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (mm && m === 'GET') {
        const sess = getSession(root, mm[1]);
        if (!sess) return json(res, 404, { ok: false, message: 'session 不存在' });
        const { paths } = resolveRoot(root);
        const reviewFile = join(paths.reviewsDir, sess.session_id, 'review.json');
        const review = existsSync(reviewFile) ? JSON.parse(readFileSync(reviewFile, 'utf8')) : null;
        return json(res, 200, {
          ok: true, session: sess,
          utterances: readUtterances(root, sess.session_id),
          questions: readQuestions(root, sess.session_id),
          review,
          events: readEvents(root, sess.session_id).map((e) => ({ type: e.type, seq: e.seq, at: e.at, payload: e.payload })),
        });
      }
      mm = path.match(/^\/api\/sessions\/([^/]+)\/correct$/);
      if (mm && m === 'POST') {
        const sid = mm[1];
        const body = await readJsonBody(req);
        const utterances = readUtterances(root, sid);
        const u = utterances.find((x) => x.id === body.utterance_id);
        if (!u) return json(res, 404, { ok: false, message: `utterance 不存在：${body.utterance_id}` });
        if (!['interviewer', 'candidate', 'unknown'].includes(body.role)) {
          return json(res, 400, { ok: false, message: 'role 必须是 interviewer/candidate/unknown' });
        }
        u.role = body.role; // raw_text 永不改写
        saveUtterances(root, sid, utterances);
        appendEvent(root, sid, { type: 'segment.corrected', payload: { utterance_id: u.id, new_role: body.role } });
        return json(res, 200, { ok: true });
      }
      mm = path.match(/^\/api\/sessions\/([^/]+)\/confirm-alignment$/);
      if (mm && m === 'POST') {
        const sid = mm[1];
        const body = await readJsonBody(req);
        const questions = readQuestions(root, sid);
        const q = questions.find((x) => x.question_id === body.question_id);
        if (!q) return json(res, 404, { ok: false, message: `question 不存在：${body.question_id}` });
        if (!['matched', 'ambiguous', 'unmatched', 'pending'].includes(body.status)) {
          return json(res, 400, { ok: false, message: 'status 非法' });
        }
        q.alignment = { status: body.status, matched_block_ids: body.matched_block_ids || [], evidence_refs: q.alignment?.evidence_refs || [] };
        saveQuestions(root, sid, questions);
        appendEvent(root, sid, { type: 'alignment.confirmed', payload: { question_id: q.question_id, status: body.status, matched_block_ids: q.alignment.matched_block_ids } });
        return json(res, 200, { ok: true });
      }

      return false; // 未处理 → 404
    } catch (e) {
      if (e instanceof ValidationError) return json(res, 400, { ok: false, message: e.message });
      if (e instanceof SyntaxError) return json(res, 400, { ok: false, message: `请求体不是合法 JSON：${e.message}` });
      return json(res, 500, { ok: false, message: `未预期错误：${e.message}` });
    }
  };
}

void http;
