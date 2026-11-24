import { existsSync, readFileSync, readdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { resolveRoot, atomicWriteJson, atomicWriteText } from './storage.mjs';
import { assertValid, ValidationError } from './validation.mjs';
import { readBlockById, writeBlock, readManifest } from './blocks.mjs';

function patchFile(root, patchId) {
  if (!/^[a-f0-9]{12}$/.test(String(patchId))) {
    throw new ValidationError(`非法 patch id（必须是 12 位 hex）：${patchId}`);
  }
  const { paths } = resolveRoot(root);
  return join(paths.patchesDir, `${patchId}.json`);
}

function savePatch(root, patch) {
  assertValid('patch', patch);
  atomicWriteJson(patchFile(root, patch.patch_id), patch);
}

function readPatch(root, patchId) {
  const f = patchFile(root, patchId);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, 'utf8'));
}

export function listPatches(root, { status } = {}) {
  const { paths } = resolveRoot(root);
  if (!existsSync(paths.patchesDir)) return [];
  return readdirSync(paths.patchesDir)
    .filter((f) => /^[a-f0-9]{12}\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(paths.patchesDir, f), 'utf8')))
    .filter((p) => !status || p.status === status)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function appendChangelog(root, line) {
  const { paths } = resolveRoot(root);
  appendFileSync(join(paths.versionsDir, 'CHANGELOG.md'), `${line}\n`, { flag: 'a' });
}

export function proposePatch(root, input) {
  const { paths } = resolveRoot(root);
  const needsTarget = ['alias_add', 'block_edit', 'archive', 'merge'].includes(input.type);
  if (needsTarget && !input.target_id) {
    throw new ValidationError(`patch 类型 ${input.type} 需要 target_id`);
  }
  // target 存在性 + base_revision/hash 校验（block_add/gap_add/fact_conflict 不要求块存在）
  if (needsTarget) {
    const block = readBlockById(root, input.target_id);
    if (!block) throw new ValidationError(`目标块不存在：${input.target_id}`);
    if (block.frontMatter.revision !== input.base_revision) {
      const stale = {
        patch_id: createHash('sha256').update(`${input.target_id}|${JSON.stringify(input.proposed_diff)}`).digest('hex').slice(0, 12),
        type: input.type,
        target_id: input.target_id,
        base_revision: input.base_revision,
        before_hash: input.before_hash || null,
        proposed_diff: input.proposed_diff,
        reason: input.reason,
        source_refs: input.source_refs || [],
        status: 'stale',
        reviewer: null,
        created_at: new Date().toISOString(),
      };
      savePatch(root, stale);
      throw new ValidationError(`patch 已过期（stale）：目标块当前 revision 是 ${block.frontMatter.revision}，提案基于 ${input.base_revision}。请基于新版本重建提案。`);
    }
    if (input.before_hash && input.before_hash !== readManifest(root).blocks[input.target_id]?.at(-1)?.hash) {
      throw new ValidationError(`before_hash 与当前内容不符，请基于最新版本重建提案`);
    }
  }
  const patch = {
    patch_id: createHash('sha256').update(`${input.target_id || input.type}|${JSON.stringify(input.proposed_diff)}`).digest('hex').slice(0, 12),
    type: input.type,
    target_id: input.target_id || null,
    base_revision: input.base_revision || null,
    before_hash: input.before_hash || null,
    proposed_diff: input.proposed_diff,
    reason: input.reason,
    source_refs: input.source_refs || [],
    status: 'pending',
    reviewer: null,
    created_at: new Date().toISOString(),
  };
  // 同 target+diff 去重（reject 的记录保留，可人工再提；stale 记录被新提案替换——否则流程死锁）
  for (const existing of listPatches(root)) {
    if (existing.patch_id !== patch.patch_id) continue;
    if (existing.status === 'stale') {
      const { paths: p2 } = resolveRoot(root);
      unlinkSync(join(p2.patchesDir, `${existing.patch_id}.json`));
      continue;
    }
    if (existing.status !== 'rejected') {
      throw new ValidationError(`重复提案：同 target+diff 的 patch 已存在（${existing.patch_id}，状态 ${existing.status}）`);
    }
  }
  savePatch(root, patch);
  return patch;
}

export function setPatchStatus(root, patchId, status, { reviewer } = {}) {
  const patch = readPatch(root, patchId);
  if (!patch) throw new ValidationError(`patch 不存在：${patchId}`);
  if (status === 'approve') {
    if (patch.status !== 'pending') throw new ValidationError(`patch ${patchId} 状态为 ${patch.status}，只有 pending 可 approve`);
    patch.status = 'approved';
    patch.reviewer = reviewer || 'user';
  } else if (status === 'reject') {
    if (patch.status !== 'pending') throw new ValidationError(`patch ${patchId} 状态为 ${patch.status}，只有 pending 可 reject`);
    patch.status = 'rejected';
    patch.reviewer = reviewer || 'user';
  }
  savePatch(root, patch);
  return patch;
}

export function applyPatch(root, patchId) {
  const patch = readPatch(root, patchId);
  if (!patch) throw new ValidationError(`patch 不存在：${patchId}`);
  if (patch.status === 'applied') return { idempotent: true, patch_id: patchId };
  if (patch.status !== 'approved') throw new ValidationError(`patch ${patchId} 状态为 ${patch.status}，只有 approved 可 apply`);
  const line = (extra) => `- ${new Date().toISOString()} ${patch.type} ${patch.target_id || ''} (${patchId}) ${patch.reason}${extra || ''}`;

  if (patch.type === 'alias_add') {
    const block = readBlockById(root, patch.target_id);
    const add = patch.proposed_diff.questions_add || [];
    writeBlock(root, { ...block.frontMatter, questions: [...block.frontMatter.questions, ...add.filter((q) => !block.frontMatter.questions.includes(q))] }, block.body);
  } else if (patch.type === 'block_edit') {
    const block = readBlockById(root, patch.target_id);
    if (!patch.proposed_diff.new_body) throw new ValidationError('block_edit 需要 proposed_diff.new_body');
    writeBlock(root, { ...block.frontMatter }, patch.proposed_diff.new_body);
  } else if (patch.type === 'archive') {
    const block = readBlockById(root, patch.target_id);
    writeBlock(root, { ...block.frontMatter, status: 'archived' }, block.body);
  } else if (patch.type === 'merge') {
    const block = readBlockById(root, patch.target_id);
    writeBlock(root, { ...block.frontMatter, status: 'superseded' }, block.body);
  } else if (patch.type === 'fact_conflict') {
    // 只写冲突记录，不改 cv.md / ledger.yml（事实更新走 evolve 审批）
    const { paths } = resolveRoot(root);
    const existing = existsSync(paths.factLinksFile)
      ? (YAML.parse(readFileSync(paths.factLinksFile, 'utf8')) || {})
      : {};
    existing.conflicts = existing.conflicts || [];
    existing.conflicts.push({
      fact_ref: patch.target_id,
      claimed: patch.proposed_diff.claimed || null,
      actual: patch.proposed_diff.actual || null,
      patch_id: patch.patch_id,
      status: 'open',
      at: new Date().toISOString(),
    });
    atomicWriteText(paths.factLinksFile, YAML.stringify(existing, { lineWidth: 0 }));
  } else if (patch.type === 'gap_add') {
    const { paths } = resolveRoot(root);
    appendFileSync(join(paths.draftsDir, 'gap-backlog.md'), `- ${patch.proposed_diff.gap || patch.reason}（${patch.patch_id}）\n`, { flag: 'a' });
  } else if (patch.type === 'block_add') {
    throw new ValidationError('block_add 请走 approve 命令（drafts 审批路径），不走 patch');
  }

  patch.status = 'applied';
  savePatch(root, patch);
  appendChangelog(root, line());
  return { idempotent: false, patch_id: patchId, status: 'applied' };
}
