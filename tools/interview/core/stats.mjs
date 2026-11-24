// 统计与优先级（spec §6.1）。核心纪律：
// - 只有「真实面试」（real_* / historical_import）进 frequency 分母；mock 全部排除
// - mastery 只数独立回答（mock_blind / real_*）；assisted 单列
// - 事实冲突块 mastery=null + needs_review，不被综合分抵消
// - 无样本显示 null，不用预测填补
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRoot } from './storage.mjs';
import { listSessions, readQuestions, readEvents } from './sessions.mjs';
import { readBlocks } from './blocks.mjs';
import { RUBRIC_WEIGHTS } from '../review/rubric.mjs';

const REAL_MODES = ['real_record_only', 'real_reference_allowed', 'historical_import'];
const INDEPENDENT_MODES = ['real_record_only', 'real_reference_allowed', 'historical_import', 'mock_blind'];
const ASSISTED_MODES = ['mock_assisted', 'mock_anchor'];

function readReview(paths, sessionId) {
  const f = join(paths.reviewsDir, sessionId, 'review.json');
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, 'utf8'));
}

function dimScore0to1(dims) {
  let num = 0;
  let den = 0;
  for (const [dim, info] of Object.entries(dims)) {
    const w = RUBRIC_WEIGHTS[dim];
    if (typeof info.score !== 'number') continue; // na/unknown 不计分母值但也不计 0
    num += info.score * w;
    den += 4 * w;
  }
  if (!den) return null;
  return num / den; // 0-1
}

function daysSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}

export function computeStats(root, { track, round, days } = {}) {
  const { paths } = resolveRoot(root);
  const blocks = readBlocks(root).filter((b) => !track || (b.frontMatter.tracks || []).includes(track));
  const cutoff = days ? Date.now() - days * 86400000 : null;
  const sessions = listSessions(root)
    .filter((s) => !round || s.round === round)
    .filter((s) => !cutoff || new Date(s.created_at).getTime() >= cutoff);
  const realSamples = [];

  for (const s of sessions) {
    if (!REAL_MODES.includes(s.mode)) continue;
    const questions = readQuestions(root, s.session_id);
    if (!questions.length) continue;
    // pending（角色/问题未确认）按题排除，不否定整场——有任一确认对齐即可入分母（规格 §6.1：pending 不进统计，非取消 session）
    if (questions.every((q) => !q.alignment || q.alignment.status === 'pending')) continue;
    const review = readReview(paths, s.session_id);
    if (!review) continue;
    realSamples.push({ session: s, questions, review });
  }

  const hitsByBlock = new Map(); // block_id -> Set(session_id)
  const indepScores = new Map(); // block_id -> [{score, at, session_id}]
  const assistedScores = new Map();
  const needsReviewBlocks = new Set();

  // frequency 门槛 = 被问到且对齐（matched），与事实冲突解耦（冲突只压制 mastery）
  for (const { session, review } of realSamples) {
    for (const q of review.questions) {
      if (!q.block_id) continue;
      if (q.needs_review) needsReviewBlocks.add(q.block_id);
      const hits = hitsByBlock.get(q.block_id) || new Set();
      hits.add(session.session_id);
      hitsByBlock.set(q.block_id, hits);
    }
  }
  // mastery 池：independent（含 mock_blind）与 assisted，来自全部 session 的 review
  // 无 review 的练习 session：rating.self 事件（服务端 revealed 标记）作为掌握度样本
  // 冲突块从所有场次收集（硬闸门不区分场次类型）
  for (const s of sessions) {
    const review = readReview(paths, s.session_id);
    if (!review) {
      // 练习 session（Practice 页产生）：从事件流取自评
      if (s.mode === 'mock_blind' || s.mode === 'mock_assisted' || s.mode === 'mock_anchor') {
        for (const ev of readEvents(root, s.session_id)) {
          if (ev.type !== 'rating.self' || !ev.payload?.block) continue;
          const pool = ev.payload.revealed ? assistedScores : indepScores;
          const arr = pool.get(ev.payload.block) || [];
          arr.push({ score: ev.payload.score / 4, at: ev.at, session_id: s.session_id });
          pool.set(ev.payload.block, arr);
        }
      }
      continue;
    }
    for (const q of review.questions) {
      if (!q.block_id) continue;
      if (q.needs_review) needsReviewBlocks.add(q.block_id);
      if (q.needs_review) continue;
      const score = dimScore0to1(q.dimensions);
      if (score === null) continue;
      if (INDEPENDENT_MODES.includes(s.mode)) {
        const arr = indepScores.get(q.block_id) || [];
        arr.push({ score, at: review.reviewed_at, session_id: s.session_id });
        indepScores.set(q.block_id, arr);
      } else if (ASSISTED_MODES.includes(s.mode)) {
        const arr = assistedScores.get(q.block_id) || [];
        arr.push({ score, at: review.reviewed_at, session_id: s.session_id });
        assistedScores.set(q.block_id, arr);
      }
    }
  }

  const masteryOf = (pool) => {
    if (!pool || !pool.length) return null;
    const last5 = [...pool].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 5);
    return last5.reduce((s, x) => s + x.score, 0) / last5.length;
  };

  const outBlocks = blocks.map((b) => {
    const bid = b.block_id;
    const hits = hitsByBlock.get(bid);
    const hitCount = hits ? hits.size : 0;
    const eligible = realSamples.length;
    const frequency = eligible > 0 ? hitCount / eligible : null;
    const lowSample = eligible > 0 && eligible < 5;
    const conflict = needsReviewBlocks.has(bid);
    const fm = b.frontMatter;
    const masteryRaw = masteryOf(indepScores.get(bid));
    const mastery = conflict ? null : masteryRaw;
    const forgetting = masteryRaw === null ? null
      : (() => {
        const pool = indepScores.get(bid) || [];
        if (!pool.length) return null;
        const last = Math.max(...pool.map((p) => new Date(p.at).getTime()));
        const d = (Date.now() - last) / 86400000;
        return Math.min(1, Math.max(0, (d - 7) / 23)); // 7 天后开始加权，30 天封顶
      })();
    const risk = fm.pinned ? 1 : (fm.criticality === 'high' ? 0.5 : 0);
    const parts = [];
    if (frequency !== null) parts.push([0.25, frequency]);
    if (mastery !== null) parts.push([0.35, 1 - mastery]);
    parts.push([0.10, risk]);
    if (forgetting !== null) parts.push([0.05, forgetting]);
    // relevance 在 P1 恒为 null（无 JD 关联数据），不进加权
    const wSum = parts.reduce((s, [w]) => s + w, 0);
    const priority = wSum > 0 ? parts.reduce((s, [w, v]) => s + w * v, 0) / wSum : null;
    return {
      block_id: bid,
      criticality: fm.criticality || 'normal',
      pinned: !!fm.pinned,
      hits: hitCount,
      frequency,
      low_sample: lowSample || undefined,
      mastery,
      mastery_assisted: masteryOf(assistedScores.get(bid)),
      mastery_samples: (indepScores.get(bid) || []).length,
      needs_review: conflict || undefined,
      relevance: null,
      risk,
      forgetting,
      priority,
    };
  });

  outBlocks.sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1));
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    filters: { track: track || null, round: round || null, days: days || null },
    real_samples: realSamples.length,
    note: realSamples.length === 0 ? '暂无真实面试样本：frequency/mastery 为 null，预测信号见 signals（不填补热度）' : null,
    blocks: outBlocks,
  };
}
