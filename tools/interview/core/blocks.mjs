import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { resolveRoot, atomicWriteText, atomicWriteJson, safeJoin, PathEscapeError } from './storage.mjs';
import { splitFrontMatter } from './yaml.mjs';
import { assertValid } from './validation.mjs';

const MANIFEST_VERSION = 1;

export class BlockIdError extends PathEscapeError {}

export function blockFilePath(root, blockId) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9._-]{0,127}$/.test(blockId)) {
    throw new PathEscapeError(`非法 block_id：${blockId}`);
  }
  return safeJoin(root, `knowledge/blocks/${blockId}.md`);
}

function renderBlock(frontMatter, body) {
  const fm = YAML.stringify(frontMatter, { lineWidth: 0 });
  return `---\n${fm}---\n${body.startsWith('\n') || body.startsWith('#') ? body : `\n${body}`}`;
}

export function readManifest(root) {
  const { paths } = resolveRoot(root);
  mkdirSync(paths.versionsDir, { recursive: true });
  const manifestFile = join(paths.versionsDir, 'manifest.json');
  if (!existsSync(manifestFile)) {
    return { schema_version: MANIFEST_VERSION, blocks: {} };
  }
  return JSON.parse(readFileSync(manifestFile, 'utf8'));
}

export function writeBlock(root, frontMatter, body) {
  const { paths } = resolveRoot(root);
  const file = blockFilePath(root, frontMatter.block_id);
  let revision = frontMatter.revision || 1;
  if (existsSync(file)) {
    const prev = splitFrontMatter(readFileSync(file, 'utf8')).frontMatter;
    revision = prev.revision + 1;
  }
  const next = { ...frontMatter, revision };
  assertValid('answer-block', next);
  const content = renderBlock(next, body);
  atomicWriteText(file, content);
  const hash = createHash('sha256').update(content).digest('hex');
  const manifest = readManifest(root);
  manifest.blocks[next.block_id] = manifest.blocks[next.block_id] || [];
  manifest.blocks[next.block_id].push({
    revision, hash, updated_at: new Date().toISOString(), status: next.status,
  });
  atomicWriteJson(join(paths.versionsDir, 'manifest.json'), manifest);
  return { revision, hash, file };
}

export function readBlocks(root, { all = false } = {}) {
  const { paths } = resolveRoot(root);
  if (!existsSync(paths.blocksDir)) return [];
  const blocks = [];
  for (const f of readdirSync(paths.blocksDir).sort()) {
    if (!f.endsWith('.md')) continue;
    const file = join(paths.blocksDir, f);
    const { frontMatter, body } = splitFrontMatter(readFileSync(file, 'utf8'));
    if (!all && frontMatter.status !== 'active') continue;
    blocks.push({ frontMatter, body, file, block_id: frontMatter.block_id });
  }
  return blocks;
}

export function readBlockById(root, blockId) {
  const file = blockFilePath(root, blockId);
  if (!existsSync(file)) return null;
  const { frontMatter, body } = splitFrontMatter(readFileSync(file, 'utf8'));
  return { frontMatter, body, file, block_id: frontMatter.block_id };
}
