import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveRoot, atomicWriteJson } from './storage.mjs';
import { assertValid } from './validation.mjs';
import { generateSeeds } from './seeds.mjs';

const DEFAULT_STATE = () => ({ schema_version: 1, state: 'not_started', track_ids: [], seed_ids: [] });

export function loadBootstrap(root) {
  const { paths } = resolveRoot(root);
  if (!existsSync(paths.bootstrapFile)) return DEFAULT_STATE();
  const raw = JSON.parse(readFileSync(paths.bootstrapFile, 'utf8'));
  assertValid('bootstrap-state', raw);
  return raw;
}

export function saveBootstrap(root, state) {
  const { paths } = resolveRoot(root);
  assertValid('bootstrap-state', state);
  atomicWriteJson(paths.bootstrapFile, state);
}

export function listSeeds(root) {
  const { paths } = resolveRoot(root);
  if (!existsSync(paths.draftsDir)) return [];
  return readdirSync(paths.draftsDir)
    .filter((f) => /^seed-[a-f0-9]{12}\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(paths.draftsDir, f), 'utf8')));
}

export function saveSeed(root, seed) {
  const { paths } = resolveRoot(root);
  assertValid('seed', seed);
  atomicWriteJson(join(paths.draftsDir, `seed-${seed.seed_id}.json`), seed);
}

export function bootstrapFromCv(root, cvText, { trackIds } = {}) {
  const cvHash = createHash('sha256').update(cvText).digest('hex');
  const state = loadBootstrap(root);
  const existing = new Set(state.seed_ids);
  const effectiveTracks = trackIds?.length ? trackIds : (state.track_ids.length ? state.track_ids : ['ai-app']);
  const seeds = generateSeeds(cvText, { trackIds: effectiveTracks });
  const newSeeds = seeds.filter((s) => !existing.has(s.seed_id));
  for (const s of newSeeds) saveSeed(root, s);
  const seedIds = [...new Set([...state.seed_ids, ...seeds.map((s) => s.seed_id)])];
  const nextState = {
    ...state,
    // paused → in_progress（恢复）；ready 不降级；其余进入 in_progress
    state: state.state === 'ready' ? 'ready' : 'in_progress',
    cv_source_hash: cvHash,
    track_ids: seeds.length ? seeds[0].tracks : state.track_ids,
    seed_ids: seedIds,
  };
  saveBootstrap(root, nextState);
  return { state: nextState.state, seed_ids: seedIds, added: newSeeds.length };
}
