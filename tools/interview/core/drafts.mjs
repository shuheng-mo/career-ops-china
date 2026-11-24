import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { resolveRoot } from './storage.mjs';
import { assertValid, ValidationError } from './validation.mjs';
import { listSeeds, saveSeed, loadBootstrap, saveBootstrap } from './bootstrap.mjs';
import { writeBlock } from './blocks.mjs';

function readRawAnswer(root, seedId) {
  const { paths } = resolveRoot(root);
  const f = join(paths.draftsDir, `answer-${seedId}.md`);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}

export function draftsExport(root) {
  const ready = listSeeds(root).filter((s) => s.status === 'draft_ready');
  return {
    instructions: '为每个 seed 生成一份答案草稿（approve 输入数组）。规则：'
      + '① 只能基于 raw_answer 里候选人的原话与 seed.fact_refs 引用的已确认事实；'
      + '② claim_kind=experience 时 fact_refs 必须全部指向已确认事实（tech-facts.yml 或 seed.fact_refs），否则会被 CLI 拒绝；'
      + '③ markdown 用「## 30 秒版 / ## 详细版 / ## 技术边界」三段；'
      + '④ 没有个人证据时不得声称候选人做过（用 knowledge/design）；'
      + '⑤ 输出 answer-draft schema 的 JSON 数组，经人工确认后由 approve 命令激活。',
    seeds: ready.map((s) => ({
      seed_id: s.seed_id,
      intent_key: s.intent_key,
      question: s.question,
      raw_answer: readRawAnswer(root, s.seed_id),
      fact_refs: s.fact_refs,
      project_ref: s.project_ref,
      tracks: s.tracks,
      rounds: s.rounds,
    })),
  };
}

function techFactIds(root) {
  const { paths } = resolveRoot(root);
  const f = paths.techFactsFile;
  if (!existsSync(f)) return new Set();
  const doc = YAML.parse(readFileSync(f, 'utf8'));
  const list = Array.isArray(doc) ? doc : (doc && doc.facts) || [];
  return new Set(list.map((x) => x.id).filter(Boolean));
}

function kindForSeed(seed) {
  return seed.intent_key.startsWith('intro.') ? 'intro' : 'qa';
}

export function approveDrafts(root, draftsObj) {
  assertValid('answer-draft', draftsObj);
  const seeds = listSeeds(root);
  const byId = new Map(seeds.map((s) => [s.seed_id, s]));
  const techFacts = techFactIds(root);
  const applied = [];
  const skipped = [];
  for (const draft of draftsObj) {
    const seed = byId.get(draft.seed_id);
    if (!seed) throw new ValidationError(`seed_id 不存在：${draft.seed_id}`);
    if (seed.status === 'linked') {
      skipped.push({ seed_id: seed.seed_id, reason: '已批准过（幂等跳过）' });
      continue;
    }
    if (seed.status !== 'draft_ready') {
      throw new ValidationError(`种子 ${draft.seed_id} 状态为 ${seed.status}，只有 draft_ready 可批准`);
    }
    if (draft.claim_kind === 'experience') {
      const unconfirmed = draft.fact_refs.filter((ref) => !seed.fact_refs.includes(ref) && !techFacts.has(ref));
      if (unconfirmed.length) {
        throw new ValidationError(
          `未确认事实不得进 active 块（block: ${draft.block_id}）：${unconfirmed.join(', ')}。`
          + 'experience 类答案的每个事实引用都必须在 tech-facts.yml（status: confirmed）或种子 fact_refs 里。'
        );
      }
    }
    const { revision } = writeBlock(root, {
      schema_version: 1,
      block_id: draft.block_id,
      kind: kindForSeed(seed),
      project: seed.project_ref || undefined,
      status: 'active',
      tracks: seed.tracks,
      rounds: seed.rounds,
      questions: draft.questions,
      anchors: draft.anchors || [],
      fact_refs: draft.fact_refs,
      claim_kind: draft.claim_kind,
      criticality: 'normal',
      pinned: false,
      source_refs: seed.source_refs,
      rubric: draft.rubric || undefined,
    }, draft.markdown);
    seed.status = 'linked';
    seed.answer_block_id = draft.block_id;
    seed.revision += 1;
    saveSeed(root, seed);
    applied.push({ seed_id: seed.seed_id, block_id: draft.block_id, revision });
  }
  const st = loadBootstrap(root);
  if (st.state !== 'ready') {
    st.state = 'ready';
    st.completed_at = new Date().toISOString();
    saveBootstrap(root, st);
  }
  return { applied, skipped };
}
