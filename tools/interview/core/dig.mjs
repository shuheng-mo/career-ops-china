import { join } from 'node:path';
import { resolveRoot, atomicWriteText } from './storage.mjs';
import { assertValid, ValidationError } from './validation.mjs';
import { listSeeds, saveSeed } from './bootstrap.mjs';

const INTENT_ORDER = [
  [/^intro\.self$/, 0],
  [/\.story$/, 1],
  [/\.contribution$/, 2],
  [/\.decision$/, 3],
  [/\.result$/, 4],
  [/\.boundary$/, 5],
];

function intentRank(intentKey) {
  for (const [re, rank] of INTENT_ORDER) {
    if (re.test(intentKey)) return rank;
  }
  return 9;
}

export function digPrepare(root, { limit = 5 } = {}) {
  const queued = listSeeds(root)
    .filter((s) => s.status === 'queued')
    .sort((a, b) => intentRank(a.intent_key) - intentRank(b.intent_key)
      || (a.project_ref || '').localeCompare(b.project_ref || ''));
  return queued.slice(0, limit);
}

const TRANSITIONS = {
  answered: 'draft_ready',
  unclear: 'needs_input',
  not_done: 'dismissed',
  skipped: 'queued',
};

export function digIngest(root, resultObj) {
  assertValid('dig-result', resultObj);
  const seeds = listSeeds(root);
  const byId = new Map(seeds.map((s) => [s.seed_id, s]));
  const bad = resultObj.results.filter((r) => !byId.has(r.seed_id));
  if (bad.length) {
    throw new ValidationError(`以下 seed_id 不存在于知识库：${bad.map((b) => b.seed_id).join(', ')}`);
  }
  const applied = [];
  const { paths } = resolveRoot(root);
  for (const r of resultObj.results) {
    if (r.status === 'answered' && (!r.raw_answer || !r.raw_answer.trim())) {
      throw new ValidationError(`种子 ${r.seed_id} 状态为 answered，但缺少 raw_answer（候选人原话）`);
    }
    const seed = byId.get(r.seed_id);
    seed.status = TRANSITIONS[r.status];
    seed.revision += 1;
    if (r.status === 'not_done' && !seed.missing_fields.includes('无此经历')) {
      seed.missing_fields.push('无此经历');
    }
    saveSeed(root, seed);
    if (r.status === 'answered') {
      // 原话原样落盘，不重写（证据纪律）
      atomicWriteText(join(paths.draftsDir, `answer-${seed.seed_id}.md`), r.raw_answer);
    }
    applied.push({ seed_id: seed.seed_id, status: seed.status });
  }
  return { applied };
}
