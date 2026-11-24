import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveRoot, atomicWriteJson, atomicWriteText } from './storage.mjs';
import { assertValid } from './validation.mjs';
import { listSeeds, saveSeed } from './bootstrap.mjs';
import { readBlocks } from './blocks.mjs';

// 问题归一化：NFKC + 小写 + 去空白/标点/符号（用于重复判断，不用于展示）
export function normalizeQuestion(q) {
  return String(q).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function questionsHash(questions) {
  return createHash('sha256').update(questions.map(normalizeQuestion).join('||')).digest('hex').slice(0, 16);
}

export function ingestOriginal(root, filePath, { originalText } = {}) {
  const { paths } = resolveRoot(root);
  const text = originalText !== undefined ? originalText : readFileSync(filePath, 'utf8');
  const hash = createHash('sha256').update(text).digest('hex');
  const short = hash.slice(0, 12);
  const dest = join(paths.imports, `${short}-${basename(filePath)}`);
  const metaFile = join(paths.imports, `${short}.meta.json`);
  if (existsSync(metaFile)) {
    return { reused: true, saved: false, hash, meta: JSON.parse(readFileSync(metaFile, 'utf8')) };
  }
  atomicWriteText(dest, text);
  atomicWriteJson(metaFile, {
    hash,
    source_path: filePath,
    imported_at: new Date().toISOString(),
    bytes: Buffer.byteLength(text, 'utf8'),
  });
  return { reused: false, saved: true, hash, dest, meta_file: metaFile };
}

export function applyCandidates(root, candidatesObj, { trackIds = ['ai-app'], now = new Date().toISOString() } = {}) {
  assertValid('import-candidates', candidatesObj);
  const seeds = listSeeds(root);
  const known = new Map();
  for (const s of seeds) {
    for (const q of [s.question, ...s.aliases]) {
      known.set(normalizeQuestion(q), s.seed_id);
    }
  }
  for (const b of readBlocks(root)) {
    for (const q of b.frontMatter.questions || []) {
      known.set(normalizeQuestion(q), `block:${b.block_id}`);
    }
  }
  const applied = [];
  const duplicates = [];
  const candidateRecords = [];
  const seenInBatch = new Map();
  const { paths } = resolveRoot(root);
  for (const c of candidatesObj) {
    const qHash = questionsHash(c.questions);
    let duplicateOf = null;
    for (const q of c.questions) {
      const hit = known.get(normalizeQuestion(q));
      if (hit) {
        duplicateOf = hit;
        break;
      }
    }
    if (!duplicateOf && seenInBatch.has(qHash)) duplicateOf = seenInBatch.get(qHash);
    const intentKey = `import.q${qHash}`;
    const seedId = createHash('sha256').update(intentKey).digest('hex').slice(0, 12);
    const record = { seed_id: seedId, intent_key: intentKey, questions: c.questions, source_locator: c.source_locator };
    candidateRecords.push(record);
    if (duplicateOf) {
      duplicates.push({ ...record, duplicate_of: duplicateOf });
      continue;
    }
    seenInBatch.set(qHash, seedId);
    const seed = {
      seed_id: seedId,
      project_ref: null,
      intent_key: intentKey,
      question: c.questions[0],
      aliases: c.questions.slice(1),
      tracks: c.tracks?.length ? c.tracks : trackIds,
      rounds: [],
      source_refs: [{ artifact_id: 'import', locator: c.source_locator }],
      fact_refs: c.fact_refs,
      origin_kind: 'story_import',
      status: 'draft_ready',
      missing_fields: [],
      answer_block_id: null,
      created_at: now,
      revision: 1,
    };
    // 候选正文先落在 drafts（未审批内容与 active 块隔离）
    atomicWriteText(join(paths.draftsDir, `import-${seedId}.md`), c.markdown);
    saveSeed(root, seed);
    known.set(normalizeQuestion(c.questions[0]), seedId);
    applied.push(record);
  }
  return { applied, duplicates, candidates: candidateRecords };
}
