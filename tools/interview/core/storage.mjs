import {
  existsSync, mkdirSync, renameSync, writeFileSync, readFileSync,
  unlinkSync, realpathSync, lstatSync, openSync, closeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url)); // tools/interview/core
const REPO_ROOT = resolve(TOOLS_DIR, '..', '..', '..');

export class PathEscapeError extends Error {
  constructor(p) {
    super(`路径越界，已拒绝（必须位于数据根目录内）：${p}`);
    this.name = 'PathEscapeError';
  }
}

const PATHS_LAYOUT = {
  imports: 'imports',
  blocksDir: 'knowledge/blocks',
  bootstrapFile: 'knowledge/bootstrap.json',
  signalsFile: 'knowledge/signals.jsonl',
  draftsDir: 'knowledge/drafts',
  factLinksFile: 'knowledge/fact-links.yml',
  techFactsFile: 'knowledge/tech-facts.yml',
  versionsDir: 'knowledge/versions',
  packsDir: 'packs',
  sessionsDir: 'sessions',
  reviewsDir: 'reviews',
  patchesDir: 'patches',
  cacheDir: 'cache',
  evalPrivateDir: 'eval-private',
};

export function resolveRoot(rootArg) {
  const root = resolve(rootArg || join(REPO_ROOT, 'interview-prep'));
  const paths = { root };
  for (const [key, rel] of Object.entries(PATHS_LAYOUT)) paths[key] = join(root, rel);
  return { root, paths };
}

function deepestExistingRealpath(p) {
  // 找到最深的已存在祖先并取其 realpath，保留其后不存在的尾部段
  // （macOS 上 /var 是 /private/var 的 symlink，非存在路径不能直接用拼接前缀判断）
  const tail = [];
  let cur = p;
  while (true) {
    try {
      const real = realpathSync(cur);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch {
      tail.unshift(basename(cur));
      const parent = dirname(cur);
      if (parent === cur) return p;
      cur = parent;
    }
  }
}

export function safeJoin(root, ...segs) {
  const rootReal = deepestExistingRealpath(root);
  const target = resolve(root, ...segs.map((s) => {
    if (typeof s !== 'string' || s.length === 0) throw new PathEscapeError(String(s));
    if (isAbsolute(s) || s === '..' || s.split(sep).includes('..') || s.includes('\0')) {
      throw new PathEscapeError(s);
    }
    return s;
  }));
  // 越界判断走 realpath 锚定（root 可能经 symlink 挂载，如 macOS /var → /private/var）；
  // 返回值保留调用方拼写，避免同一文件出现两套路径
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new PathEscapeError(target);
  const anchoredReal = deepestExistingRealpath(join(rootReal, rel));
  if (anchoredReal !== rootReal && !anchoredReal.startsWith(rootReal + sep)) {
    throw new PathEscapeError(target);
  }
  return target;
}

export function atomicWriteText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function atomicWriteJson(file, obj) {
  atomicWriteText(file, JSON.stringify(obj, null, 2) + '\n');
}

export function appendJsonl(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  // 自愈：崩溃可能留下尾部半行——追加前截掉，否则新行与半行粘连（历史有效行保留）
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    if (text.length && !text.endsWith('\n')) {
      const lastNl = text.lastIndexOf('\n');
      writeFileSync(file, lastNl === -1 ? '' : text.slice(0, lastNl + 1));
    }
  }
  writeFileSync(file, JSON.stringify(obj) + '\n', { flag: 'a' });
}

export function readJsonlSafe(file) {
  if (!existsSync(file)) return { rows: [], recovered: 0 };
  const text = readFileSync(file, 'utf8');
  const rows = [];
  let recovered = 0;
  let rest = text;
  while (rest.length) {
    const nl = rest.indexOf('\n');
    if (nl === -1) {
      if (rest.trim()) recovered += 1; // 尾部不完整行：丢弃并计数
      break;
    }
    const line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    if (line.trim()) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        recovered += 1;
      }
    }
  }
  return { rows, recovered };
}

export function withLock(file, fn) {
  mkdirSync(dirname(file), { recursive: true });
  const lockFile = `${file}.lock`;
  let fd;
  try {
    fd = openSync(lockFile, 'wx');
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      throw new Error(`另一个进程正在写：${file}（如确认无并发，手动删除 ${lockFile}）`);
    }
    throw e;
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(lockFile);
  }
}
