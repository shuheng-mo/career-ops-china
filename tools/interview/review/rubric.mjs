import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveRoot, atomicWriteJson, atomicWriteText } from '../core/storage.mjs';
import { assertValid, ValidationError } from '../core/validation.mjs';
import { readUtterances, readQuestions, appendEvent, getSession } from '../core/sessions.mjs';
import { readBlockById } from '../core/blocks.mjs';
import { saveSeed } from '../core/bootstrap.mjs';

// Rubric 权重固定（spec §5.2），评审可配版本但权重是常量
export const RUBRIC_WEIGHTS = {
  accuracy: 30,           // 事实准确性
  coverage: 25,           // 核心要点覆盖
  relevance: 20,          // 问题相关性
  clarity: 15,            // 表达结构与清晰度
  boundary_honesty: 10,   // 技术边界诚实性
};
export const RUBRIC_VERSION = 'rubric-v1-2026-11-24';
const RULES = [
  'unknown/na 不当 0 分，也不当作满分；有不可评估维度时在 summary 报 coverage',
  '事实准确性依据「确认事实 + 候选人原话」判，未知不判错',
  '关键词/数字检测只是候选信号：否定、引用面试官、ASR 错误都可能误报，没有把握就标 unknown',
  '只能对文本可观察信息评分：没有时间戳/音频不得推断语速语气',
  '原话引用必须用 evidence_refs 指向 utterance id，不得改写引语',
];

export function reviewPrepare(root, sessionId) {
  const questions = readQuestions(root, sessionId);
  const matched = questions.filter((q) => q.alignment?.status === 'matched');
  const utterances = readUtterances(root, sessionId);
  const byUttId = new Map(utterances.map((u) => [u.id, u]));
  const taskQuestions = [];
  for (const q of matched) {
    const block = q.alignment.matched_block_ids[0] ? readBlockById(root, q.alignment.matched_block_ids[0]) : null;
    taskQuestions.push({
      question_id: q.question_id,
      question_text: q.text,
      utterance_refs: q.utterance_refs,
      original: q.utterance_refs.map((ref) => ({
        id: ref,
        role: byUttId.get(ref)?.role || 'unknown',
        raw_text: byUttId.get(ref)?.raw_text || '',
      })),
      block_id: block?.block_id || null,
      block_content: block ? `${block.body}` : null,
      block_fact_refs: block?.frontMatter.fact_refs || [],
    });
  }
  return {
    session_id: sessionId,
    rubric: { version: RUBRIC_VERSION, weights: RUBRIC_WEIGHTS, rules: RULES },
    questions: taskQuestions,
  };
}

export function reviewApply(root, sessionId, resultObj) {
  assertValid('review-result', resultObj);
  const questions = readQuestions(root, sessionId);
  const byQid = new Map(questions.map((q) => [q.question_id, q]));
  const utteranceIds = new Set(readUtterances(root, sessionId).map((u) => u.id));
  // 校验：evidence 引用存在、question 存在
  for (const r of resultObj) {
    if (!byQid.has(r.question_id)) {
      throw new ValidationError(`question_id 不存在于 session：${r.question_id}`);
    }
    for (const dim of Object.values(r.dimensions)) {
      const bad = (dim.evidence_refs || []).filter((ref) => !utteranceIds.has(ref));
      if (bad.length) {
        throw new ValidationError(`evidence_refs 引用不存在：${bad.join(', ')}`);
      }
    }
  }
  const scored = [];
  const newQuestions = [];
  for (const r of resultObj) {
    const q = byQid.get(r.question_id);
    const hasConflict = Array.isArray(r.fact_conflicts) && r.fact_conflicts.length > 0;
    scored.push({
      question_id: r.question_id,
      block_id: r.block_id || q.alignment?.matched_block_ids?.[0] || null,
      needs_review: hasConflict,
      mastery_eligible: !hasConflict && q.alignment?.status === 'matched',
      dimensions: r.dimensions,
      fact_conflicts: r.fact_conflicts || [],
      practice_action: r.practice_action || null,
      new_question: r.new_question || null,
    });
    if (r.new_question) newQuestions.push(r.new_question);
    appendEvent(root, sessionId, {
      type: 'alignment.confirmed',
      payload: { question_id: r.question_id, needs_review: hasConflict, rubric_version: RUBRIC_VERSION },
    });
  }
  // unmatched 新问题 → 待确认种子（origin_kind transcript, queued）+ drafts 文件
  const { paths } = resolveRoot(root);
  for (const nq of newQuestions) {
    const h = createHash('sha256').update(nq).digest('hex').slice(0, 16);
    const intentKey = `transcript.q${h.slice(0, 12)}`;
    if (!existsSync(join(paths.draftsDir, `q-${h}.md`))) {
      atomicWriteText(join(paths.draftsDir, `q-${h}.md`), `# 待确认新问题\n\n${nq}\n\n来源：session ${sessionId} 复盘（未被知识库命中）\n`);
    }
    const seedId = createHash('sha256').update(intentKey).digest('hex').slice(0, 12);
    const already = readdirSync(paths.draftsDir).some((f) => f === `seed-${seedId}.json`);
    if (!already) {
      saveSeed(root, {
        seed_id: seedId,
        project_ref: null,
        intent_key: intentKey,
        question: nq,
        aliases: [],
        tracks: ['ai-app'],
        rounds: [],
        source_refs: [{ artifact_id: `session:${sessionId}`, locator: 'review:new_question' }],
        fact_refs: [],
        origin_kind: 'transcript',
        status: 'queued',
        missing_fields: [],
        answer_block_id: null,
        created_at: new Date().toISOString(),
        revision: 1,
      });
    }
  }
  const session = getSession(root, sessionId);
  const reviewJson = {
    schema_version: 1,
    session_id: sessionId,
    application_num: session?.application_num ?? null,
    round: session?.round ?? null,
    rubric_version: RUBRIC_VERSION,
    reviewed_at: new Date().toISOString(),
    questions: scored,
    summary: {
      top_improvements: scored
        .filter((s) => s.practice_action)
        .sort((a, b) => (b.needs_review ? 1 : 0) - (a.needs_review ? 1 : 0))
        .slice(0, 3)
        .map((s) => s.practice_action),
      needs_review: scored.filter((s) => s.needs_review).map((s) => s.question_id),
      new_questions: newQuestions,
    },
  };
  const reviewsDir = join(paths.reviewsDir, sessionId);
  mkdirSync(reviewsDir, { recursive: true });
  atomicWriteJson(join(reviewsDir, 'review.json'), reviewJson);
  atomicWriteText(join(reviewsDir, 'review.md'), renderReviewMd(root, sessionId, reviewJson, readUtterances(root, sessionId)));
  return { questions: scored.length, needs_review: reviewJson.summary.needs_review.length, new_questions: newQuestions.length };
}

function utteranceText(utterances, ref) {
  const u = utterances.find((x) => x.id === ref);
  return u ? u.raw_text : '';
}

export function renderReviewMd(root, sessionId, review, utterances) {
  const lines = [];
  if (review.summary.needs_review.length) {
    lines.push('## ⛔ 事实冲突硬闸门', '', `以下问题存在已确认的事实冲突，相关块不计掌握度，须先核对口径：${review.summary.needs_review.join(', ')}`, '');
  }
  lines.push(`# 面试复盘 — session ${sessionId}`, '', `rubric: ${review.rubric_version} · 复盘时间: ${review.reviewed_at}`, '');
  for (const q of review.questions) {
    const qRec = readQuestions(root, sessionId).find((x) => x.question_id === q.question_id);
    lines.push(`## ${q.question_id}${q.needs_review ? '（needs_review）' : ''}`, '');
    if (qRec) {
      lines.push(`**问题原话（${qRec.utterance_refs.join(', ')}）：** ${qRec.text}`, '');
    }
    lines.push('| 维度 | 分数 | 依据 |', '|---|---|---|');
    for (const [dim, info] of Object.entries(q.dimensions)) {
      lines.push(`| ${dim} | ${info.score} | ${info.reason} |`);
    }
    if (q.fact_conflicts.length) {
      lines.push('', '**事实冲突：**');
      for (const c of q.fact_conflicts) {
        lines.push(`- 原话声称「${c.claimed}」vs 知识库「${c.actual}」（${c.fact_ref}）`);
      }
    }
    if (q.practice_action) lines.push('', `**练习动作：** ${q.practice_action}`);
    lines.push('');
  }
  lines.push('## 总结', '', `- 优先改进（≤3）：${review.summary.top_improvements.join('；') || '（无）'}`);
  if (review.summary.new_questions.length) {
    lines.push(`- 新问题（待确认入种子）：${review.summary.new_questions.join('；')}`);
  }
  lines.push('');
  return lines.join('\n');
}
