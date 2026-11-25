// Pack 编译（spec §7）：确定性选块 + coverage_gaps + pack.json。
// 规则：needs_review 块 → hard_gates（不进 selected）；track 命中 → stats 优先级降序 →
// criticality high>normal>low → block_id；预算按 estimated_minutes（high 15 / normal 10 / low 5）截断。
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveRoot, atomicWriteJson } from '../core/storage.mjs';
import { assertValid, ValidationError } from '../core/validation.mjs';
import { readBlocks, readManifest } from '../core/blocks.mjs';
import { listSeeds } from '../core/bootstrap.mjs';
import { computeStats } from '../core/stats.mjs';
import { currentKbRevision } from '../core/sessions.mjs';
import { gatherContext } from './context.mjs';

const MINUTES_BY_CRITICALITY = { high: 15, normal: 10, low: 5 };
const CRITICALITY_RANK = { high: 0, normal: 1, low: 2 };

export function compilePack(root, ctx, { prepMinutes = 60, now = new Date().toISOString() } = {}) {
  const { paths } = resolveRoot(root);
  const packWarnings = [...(ctx.warnings || [])];
  const track = ctx.application?.track || null;
  const stats = computeStats(root, { track: track || undefined });
  const statByBlock = new Map(stats.blocks.map((b) => [b.block_id, b]));

  // track 命中优先（非排他）：跨 track 通用块（自我介绍/项目故事）仍进包，命中块排前
  const all = readBlocks(root);
  const gated = all.filter((b) => statByBlock.get(b.block_id)?.needs_review);
  const candidates = all.filter((b) => !statByBlock.get(b.block_id)?.needs_review);
  const trackHit = (b) => (track && (b.frontMatter.tracks || []).includes(track)) ? 1 : 0;

  candidates.sort((a, b) => {
    const tha = trackHit(a), thb = trackHit(b);
    if (thb !== tha) return thb - tha;
    const pa = statByBlock.get(a.block_id)?.priority ?? -1;
    const pb = statByBlock.get(b.block_id)?.priority ?? -1;
    if (pb !== pa) return pb - pa;
    const ca = CRITICALITY_RANK[a.frontMatter.criticality || 'normal'] - CRITICALITY_RANK[b.frontMatter.criticality || 'normal'];
    if (ca !== 0) return ca;
    return a.block_id.localeCompare(b.block_id);
  });

  let budget = prepMinutes;
  const selected = [];
  const skippedByBudget = [];
  for (const b of candidates) {
    const mins = MINUTES_BY_CRITICALITY[b.frontMatter.criticality || 'normal'];
    if (budget < mins) { skippedByBudget.push(b.block_id); continue; }
    budget -= mins;
    selected.push({
      id: b.block_id,
      revision: b.frontMatter.revision,
      priority: statByBlock.get(b.block_id)?.priority ?? null,
      estimated_minutes: mins,
      reason: statByBlock.get(b.block_id)?.frequency != null
        ? `真实面试命中 ${statByBlock.get(b.block_id).hits} 次`
        : '知识块（无真实样本，按风险/优先级排序）',
    });
  }

  if (skippedByBudget.length) {
    packWarnings.push(`预算不足（${prepMinutes} 分钟），未覆盖块：${skippedByBudget.join(', ')}`);
  }

  const hardGates = gated.map((b) => ({
    id: b.block_id,
    reason: '存在未解决的事实冲突（复盘 needs_review）——练习前先核对口径，不得按本块内容作答',
  }));

  // coverage_gaps：同 track 的 queued 种子优先，跨 track 通用种子补足，取 ≤5
  const queued = listSeeds(root)
    .filter((s) => s.status === 'queued')
    .sort((a, b) => {
      const ha = track && a.tracks.includes(track) ? 1 : 0;
      const hb = track && b.tracks.includes(track) ? 1 : 0;
      if (hb !== ha) return hb - ha;
      return a.intent_key.localeCompare(b.intent_key);
    });
  const coverageGaps = queued.slice(0, 5).map((s) => s.question);

  const kbRev = currentKbRevision(root);
  const seedForId = `${ctx.application.num}|${ctx.round}|${kbRev}|${selected.map((s) => `${s.id}@${s.revision}`).join(',')}`;
  let packId = `pack-${createHash('sha256').update(seedForId).digest('hex').slice(0, 12)}`;
  // 同 id 已冻结 → 重编译派生新 id（冻结包不可覆盖）
  for (let i = 2; existsSync(join(paths.packsDir, packId, 'pack.json'))
    && JSON.parse(readFileSync(join(paths.packsDir, packId, 'pack.json'), 'utf8')).status === 'frozen'; i++) {
    packId = `pack-${createHash('sha256').update(`${seedForId}#${i}`).digest('hex').slice(0, 12)}`;
  }
  const pack = {
    pack_id: packId,
    application_num: ctx.application.num,
    round: ctx.round,
    track,
    created_at: now,
    kb_revision: kbRev,
    cv_source: ctx.cv.source,
    cv_snapshot_hash: ctx.cv.hash,
    submitted_pdf: ctx.submitted_pdf || null,
    jd_source: ctx.report.url || null,
    report_source: reportSource(ctx),
    research_refs: ctx.research,
    selected_blocks: selected,
    hard_gates: hardGates,
    overlays: buildOverlays(ctx),
    rounds_feedback: ctx.rounds_feedback,
    coverage_gaps: coverageGaps,
    warnings: packWarnings,
    prep_minutes: prepMinutes,
    status: 'draft',
  };
  assertValid('pack', pack);
  const dir = join(paths.packsDir, packId);
  mkdirSync(dir, { recursive: true });
  atomicWriteJson(join(dir, 'pack.json'), pack);
  return pack;
}

function reportSource(ctx) {
  return ctx.report.found ? ctx.report.path : null;
}

// overlays：来自 report 的公司资料与轮次反馈摘要（逐字引用，不生成新信息）
function buildOverlays(ctx) {
  const overlays = [];
  for (const r of ctx.research) {
    overlays.push(
      `【公司资料（${r.freshness}${r.freshness === 'fresh' ? '' : '，' + r.retrieved_at + ' 检索'}）】${r.claim}`
    );
  }
  for (const fb of ctx.rounds_feedback) {
    overlays.push(`【前轮反馈 ${fb.round || ''} ${fb.date || ''}：${fb.result || ''}】${fb.feedback || ''}`.trim());
  }
  return overlays;
}

export function buildPackCommand(root, args) {
  const ctx = gatherContext(root, args);
  return compilePack(root, ctx, { prepMinutes: args.prepMinutes ?? 60 });
}
