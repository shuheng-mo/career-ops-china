import { existsSync } from 'node:fs';
import { resolveRoot } from '../core/storage.mjs';
import { assertValid, ValidationError } from '../core/validation.mjs';
import { readUtterances, readQuestions, saveQuestions, appendEvent } from '../core/sessions.mjs';

export function segmentExport(root, sessionId) {
  const utterances = readUtterances(root, sessionId);
  return {
    instructions: '识别真实问题、追问、复合问题与寒暄。规则：'
      + '① question_id 从 q001 递增；'
      + '② utterance_refs 引用 utterance id（存在性由 CLI 校验），问题可跨多条 utterance；'
      + '③ 问候/闲聊标 non_question；'
      + '④ 复合问题标 compound（对齐阶段可映射多个块）；'
      + '⑤ 原话引用由程序按 span 取回——不要改写、不要生成引语。',
    session_id: sessionId,
    utterances: utterances.map((u) => ({ id: u.id, role: u.role, raw_text: u.raw_text })),
  };
}

export function segmentApply(root, sessionId, resultObj) {
  assertValid('segmentation-result', resultObj);
  const utterances = readUtterances(root, sessionId);
  const uttIds = new Set(utterances.map((u) => u.id));
  const bad = [];
  for (const r of resultObj.results) {
    for (const ref of r.utterance_refs) {
      if (!uttIds.has(ref)) bad.push(ref);
    }
  }
  if (bad.length) {
    throw new ValidationError(`utterance 引用不存在于 session：${[...new Set(bad)].join(', ')}`);
  }
  const byId = new Map(utterances.map((u) => [u.id, u]));
  const nextQuestions = resultObj.results
    .filter((r) => r.kind !== 'non_question')
    .map((r) => ({
      question_id: r.question_id,
      utterance_refs: r.utterance_refs,
      kind: r.kind,
      // 问题文本由程序按 span 取回原话，不是模型生成的引语
      text: r.utterance_refs.map((ref) => byId.get(ref).raw_text).join(' / '),
      alignment: { status: 'pending', matched_block_ids: [], evidence_refs: [] },
      notes: r.notes || null,
    }));
  const prev = readQuestions(root, sessionId);
  const sameSet = (a, b) => JSON.stringify(a.map((x) => [x.question_id, x.utterance_refs, x.kind]).sort())
    === JSON.stringify(b.map((x) => [x.question_id, x.utterance_refs, x.kind]).sort());
  if (prev.length && sameSet(prev, nextQuestions)) {
    return { questions: nextQuestions.length, idempotent: true };
  }
  saveQuestions(root, sessionId, nextQuestions);
  for (const q of nextQuestions) {
    appendEvent(root, sessionId, { type: 'question.detected', payload: { question_id: q.question_id, kind: q.kind, utterance_refs: q.utterance_refs } });
  }
  return { questions: nextQuestions.length, idempotent: false };
}
