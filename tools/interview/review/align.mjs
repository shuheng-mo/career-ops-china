import { assertValid, ValidationError } from '../core/validation.mjs';
import { readUtterances, readQuestions, saveQuestions, appendEvent } from '../core/sessions.mjs';
import { readBlocks } from '../core/blocks.mjs';
import { buildIndex, search } from '../retrieval/bm25.mjs';

export function alignExport(root, sessionId, { topK = 5 } = {}) {
  const questions = readQuestions(root, sessionId);
  if (!questions.length) {
    throw new ValidationError('session 尚未切分问题（先跑 segment apply）');
  }
  const blocks = readBlocks(root);
  const index = buildIndex(blocks);
  return {
    instructions: '把每个问题对齐到知识块。规则：'
      + '① 优先在 candidates 里选；都不合适就标 unmatched（不得强行对齐）；'
      + '② matched/ambiguous 必须给 evidence_refs（引用问题所在 utterance id）；'
      + '③ 说话人/角色未确认的问题标 pending，不进统计；'
      + '④ ambiguous = 两个候选块都可能相关。',
    session_id: sessionId,
    questions: questions.map((q) => ({
      question_id: q.question_id,
      question_text: q.text,
      kind: q.kind,
      utterance_refs: q.utterance_refs,
      candidates: search(index, q.text, { topK }).map((r) => ({ block_id: r.blockId, score: Math.round(r.score * 100) / 100 })),
    })),
  };
}

export function alignApply(root, sessionId, resultObj) {
  assertValid('alignment-result', resultObj);
  const questions = readQuestions(root, sessionId);
  const byQid = new Map(questions.map((q) => [q.question_id, q]));
  const utteranceIds = new Set(readUtterances(root, sessionId).map((u) => u.id));
  const activeBlocks = new Set(readBlocks(root).map((b) => b.block_id));
  for (const r of resultObj.results) {
    if (!byQid.has(r.question_id)) {
      throw new ValidationError(`question_id 不存在于 session：${r.question_id}`);
    }
    for (const bid of r.matched_block_ids) {
      if (!activeBlocks.has(bid)) {
        throw new ValidationError(`matched 块不存在或非 active：${bid}`);
      }
    }
    if (r.status === 'matched' || r.status === 'ambiguous') {
      if (!r.evidence_refs.length) {
        throw new ValidationError(`${r.status} 必须给 evidence_refs（utterance id）`);
      }
      const bad = r.evidence_refs.filter((ref) => !utteranceIds.has(ref));
      if (bad.length) {
        throw new ValidationError(`evidence_refs 引用不存在：${bad.join(', ')}`);
      }
    }
  }
  for (const r of resultObj.results) {
    const q = byQid.get(r.question_id);
    q.alignment = {
      status: r.status,
      matched_block_ids: r.matched_block_ids,
      evidence_refs: r.evidence_refs,
      reasoning_summary: r.reasoning_summary || null,
    };
    appendEvent(root, sessionId, {
      type: 'alignment.proposed',
      payload: { question_id: r.question_id, status: r.status, matched_block_ids: r.matched_block_ids },
    });
  }
  saveQuestions(root, sessionId, questions);
  return { aligned: resultObj.results.length };
}
