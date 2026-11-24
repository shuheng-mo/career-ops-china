#!/usr/bin/env node
// Interview Studio CLI — npm run interview:kb -- <command> [flags]
// 规格契约见 docs/interview-studio/spec-v0.2.md §11；退出码：0 成功 / 1 未预期 /
// 2 校验失败 / 3 用法错误 / 4 目标不存在。
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoot, safeJoin, PathEscapeError } from './core/storage.mjs';
import { splitFrontMatter, loadYamlSafe, YamlSafeError } from './core/yaml.mjs';
import { assertValid, ValidationError } from './core/validation.mjs';
import { loadBootstrap, listSeeds, bootstrapFromCv } from './core/bootstrap.mjs';
import { digPrepare, digIngest } from './core/dig.mjs';
import { draftsExport, approveDrafts } from './core/drafts.mjs';

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

function readInterviewConfig() {
  const cfgPath = join(REPO_ROOT, 'config', 'profile.yml');
  if (!existsSync(cfgPath)) {
    return { ok: true, detail: 'default (disabled)：config/profile.yml 不存在，interview 模块未启用' };
  }
  try {
    const cfg = loadYamlSafe(readFileSync(cfgPath, 'utf8'));
    const iv = cfg && cfg.interview;
    if (!iv || typeof iv !== 'object') {
      return { ok: true, detail: 'default (disabled)：profile.yml 无 interview 段' };
    }
    return iv.enabled
      ? { ok: true, detail: `enabled（storage: ${iv.storage || 'interview-prep'}）` }
      : { ok: true, detail: 'default (disabled)：interview.enabled=false' };
  } catch (e) {
    return { ok: false, detail: `config/profile.yml 解析失败：${e.message}` };
  }
}

export const EXIT = { OK: 0, UNEXPECTED: 1, VALIDATION: 2, USAGE: 3, NOT_FOUND: 4 };

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function output(jsonFlag, payload, { ok = true } = {}) {
  if (jsonFlag) {
    console.log(JSON.stringify({ ok, ...payload }, null, 2));
  } else if (ok) {
    if (payload.message) console.log(payload.message);
  } else {
    console.error(payload.message);
  }
}

function makeExit(jsonFlag) {
  return (code, message, extra = {}) => {
    output(jsonFlag, { message, ...extra }, { ok: false });
    process.exit(code);
  };
}

function checkRubricUnique(fm) {
  const dup = [];
  const rub = fm.rubric || {};
  for (const section of ['required', 'forbidden']) {
    const seen = new Set();
    for (const item of rub[section] || []) {
      if (seen.has(item.id)) dup.push(`${section}.${item.id}`);
      seen.add(item.id);
    }
  }
  return dup;
}

const commands = {
  bootstrap({ flags, jsonFlag, fail, output }) {
    if (flags.from && flags.from !== 'cv') {
      return fail(EXIT.USAGE, `不支持的 bootstrap 来源「${flags.from}」，目前仅支持 --from cv`);
    }
    const { root } = resolveRoot(flags.root);
    if (!flags.from || !flags.cv) {
      // bootstrap status（无 --from/--cv 参数时）
      if (!flags.from) {
        const st = loadBootstrap(root);
        const seeds = listSeeds(root);
        const byStatus = {};
        for (const s of seeds) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
        output(jsonFlag, {
          message: `bootstrap 状态：${st.state}；种子 ${seeds.length} 个（${Object.entries(byStatus).map(([k, v]) => `${k}:${v}`).join(' / ') || '无'}）`,
          state: st.state,
          seed_count: seeds.length,
          by_status: byStatus,
        });
        return;
      }
      return fail(EXIT.USAGE, '用法：bootstrap --from cv [--cv <cv.md 路径>]');
    }
    const cvPath = flags.cv === true ? join(REPO_ROOT, 'cv.md') : flags.cv;
    if (!existsSync(cvPath)) {
      return fail(EXIT.NOT_FOUND, `找不到 CV：${cvPath}。先完成 CV setup，或用 --cv 指定路径。`);
    }
    const cvText = readFileSync(cvPath, 'utf8');
    const result = bootstrapFromCv(root, cvText, { trackIds: flags.track ? [flags.track] : [] });
    output(jsonFlag, {
      message: `✓ bootstrap：state=${result.state}，种子 ${result.seed_ids.length} 个（本次新增 ${result.added}）`,
      ...result,
    });
  },

  seed({ flags, jsonFlag, fail, output, positional }) {
    const sub = positional[0] || 'list';
    if (sub !== 'list') return fail(EXIT.USAGE, `未知 seed 子命令「${sub}」，可用：list`);
    const { root } = resolveRoot(flags.root);
    let seeds = listSeeds(root);
    if (flags.status) seeds = seeds.filter((s) => s.status === flags.status);
    if (jsonFlag) {
      output(jsonFlag, { seeds });
    } else {
      const lines = seeds.map((s) => `  [${s.status}] ${s.intent_key} — ${s.question} (seed_id: ${s.seed_id})`);
      console.log(`共 ${seeds.length} 个种子：\n${lines.join('\n')}`);
    }
  },

  drafts({ flags, jsonFlag, fail, output, positional }) {
    const sub = positional[0] || 'export';
    if (sub !== 'export') return fail(EXIT.USAGE, `未知 drafts 子命令「${sub}」，可用：export`);
    const { root } = resolveRoot(flags.root);
    const task = draftsExport(root);
    if (!task.seeds.length) {
      return fail(EXIT.NOT_FOUND, '没有 draft_ready 状态的种子（先跑 dig prepare / dig ingest）。');
    }
    if (jsonFlag) return output(jsonFlag, task);
    console.log(task.instructions);
    console.log('\n待起草种子：');
    for (const s of task.seeds) {
      console.log(`\n[${s.seed_id}] ${s.question}\n  原话：${(s.raw_answer || '').slice(0, 200)}`);
    }
  },

  approve({ flags, jsonFlag, fail, output }) {
    if (!flags.file || flags.file === true) return fail(EXIT.USAGE, '用法：approve --file <drafts.json>');
    if (!existsSync(flags.file)) return fail(EXIT.NOT_FOUND, `文件不存在：${flags.file}`);
    let obj;
    try {
      obj = JSON.parse(readFileSync(flags.file, 'utf8'));
    } catch (e) {
      return fail(EXIT.VALIDATION, `草稿文件不是合法 JSON：${e.message}`);
    }
    const { root } = resolveRoot(flags.root);
    try {
      const result = approveDrafts(root, obj);
      return output(jsonFlag, {
        message: `✓ approve：激活 ${result.applied.length} 块，跳过 ${result.skipped.length}（幂等）`,
        ...result,
      });
    } catch (e) {
      if (e instanceof ValidationError) return fail(EXIT.VALIDATION, e.message);
      throw e;
    }
  },

  dig({ flags, jsonFlag, fail, output, positional }) {
    const sub = positional[0];
    const { root } = resolveRoot(flags.root);
    if (sub === 'prepare') {
      const questions = digPrepare(root, { limit: Number(flags.limit) || 5 });
      if (jsonFlag) return output(jsonFlag, { questions });
      const lines = questions.map((q, i) => `${i + 1}. ${q.question}\n   (${q.intent_key}, seed_id: ${q.seed_id})`);
      console.log(`本轮深挖 ${questions.length} 题（候选人可答 / 可跳过 / 可说记不清 / 可明确说没做过）：\n${lines.join('\n')}`);
      return;
    }
    if (sub === 'ingest') {
      if (!flags.file || flags.file === true) return fail(EXIT.USAGE, '用法：dig ingest --file <result.json>');
      if (!existsSync(flags.file)) return fail(EXIT.NOT_FOUND, `文件不存在：${flags.file}`);
      let obj;
      try {
        obj = JSON.parse(readFileSync(flags.file, 'utf8'));
      } catch (e) {
        return fail(EXIT.VALIDATION, `结果文件不是合法 JSON：${e.message}`);
      }
      try {
        const result = digIngest(root, obj);
        return output(jsonFlag, {
          message: `✓ dig ingest：处理 ${result.applied.length} 个种子`,
          ...result,
        });
      } catch (e) {
        if (e instanceof ValidationError) return fail(EXIT.VALIDATION, e.message);
        throw e;
      }
    }
    return fail(EXIT.USAGE, '用法：dig prepare | dig ingest --file <result.json>');
  },

  init({ flags, jsonFlag, fail, output }) {
    const { root, paths } = resolveRoot(flags.root);
    const DIRS = [
      paths.imports, paths.blocksDir, paths.draftsDir, paths.versionsDir,
      dirname(paths.bootstrapFile), dirname(paths.signalsFile),
      paths.packsDir, paths.sessionsDir, paths.reviewsDir, paths.patchesDir,
      paths.cacheDir, paths.evalPrivateDir,
    ];
    let created = 0;
    try {
      for (const dir of DIRS) {
        mkdirSync(dir, { recursive: true });
        const keep = join(dir, '.gitkeep');
        if (!existsSync(keep)) {
          writeFileSync(keep, '');
          created++;
        }
      }
    } catch (e) {
      return fail(e instanceof PathEscapeError ? EXIT.VALIDATION : EXIT.UNEXPECTED, e.message);
    }
    output(jsonFlag, {
      message: `✓ init 完成：${root}（新建 ${created} 项；幂等，可重复运行）`,
      root,
    });
  },

  doctor({ flags, jsonFlag, fail, output }) {
    const { root } = resolveRoot(flags.root);
    const checks = {};
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    checks.node = { ok: nodeMajor >= 22, detail: `node ${process.versions.node}${nodeMajor >= 22 ? '' : '（需要 22/24 LTS）'}` };
    checks.yaml = { ok: existsSync(join(REPO_ROOT, 'node_modules', 'yaml')), detail: 'yaml ^2 已安装' };
    checks.ajv = { ok: existsSync(join(REPO_ROOT, 'node_modules', 'ajv')), detail: 'ajv ^8 已安装' };
    let writableOk = false;
    if (existsSync(root)) {
      const probe = join(root, `.doctor-probe-${process.pid}`);
      try {
        writeFileSync(probe, '');
        unlinkSync(probe);
        writableOk = true;
      } catch {}
    }
    checks.writable = { ok: writableOk, detail: writableOk ? root : (existsSync(root) ? `${root} 不可写` : `${root} 不存在（先运行 init）`) };
    const cfg = readInterviewConfig();
    checks.config = cfg;
    const allOk = Object.values(checks).every((c) => c.ok);
    if (!allOk) {
      const bad = Object.entries(checks).filter(([, c]) => !c.ok).map(([k, c]) => `${k}: ${c.detail}`);
      output(jsonFlag, { message: `doctor 检查未通过：\n- ${bad.join('\n- ')}`, checks }, { ok: false });
      process.exit(EXIT.VALIDATION);
    }
    output(jsonFlag, { message: `✓ doctor 检查全部通过：${root}`, checks });
  },

  validate({ flags, jsonFlag, fail }) {
    if (!flags.file || flags.file === true) return fail(EXIT.USAGE, '用法：validate --file <block.md>');
    if (!existsSync(flags.file)) return fail(EXIT.NOT_FOUND, `文件不存在：${flags.file}`);
    let text;
    try {
      text = readFileSync(flags.file, 'utf8');
    } catch (e) {
      return fail(EXIT.UNEXPECTED, `读取失败：${e.message}`);
    }
    let fm;
    try {
      fm = splitFrontMatter(text).frontMatter;
    } catch (e) {
      return fail(EXIT.VALIDATION, e.message);
    }
    try {
      assertValid('answer-block', fm);
    } catch (e) {
      return fail(EXIT.VALIDATION, e.message);
    }
    const dups = checkRubricUnique(fm);
    if (dups.length) {
      return fail(EXIT.VALIDATION, `rubric id 重复：${dups.join(', ')}（同一区段内 id 必须唯一）`);
    }
    output(jsonFlag, {
      message: `✓ 校验通过：${fm.block_id} (revision ${fm.revision})`,
      block_id: fm.block_id,
      revision: fm.revision,
    });
  },
};

function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgs(argv);
  const jsonFlag = !!flags.json;
  const command = positional[0];
  const fail = makeExit(jsonFlag);

  if (!command) {
    fail(EXIT.USAGE, '用法：interview:kb -- <command> [flags]。可用命令：validate（P0）；更多命令随 Phase 1 增加。--help 查看说明。');
  }
  if (flags.help && command === 'help') {
    console.log('npm run interview:kb -- <command> [flags]\n命令：validate --file <block.md>');
    process.exit(EXIT.OK);
  }
  const cmd = commands[command];
  if (!cmd) {
    fail(EXIT.USAGE, `未知命令「${command}」。可用命令：${Object.keys(commands).join(', ')}`);
  }
  cmd({ flags, positional: positional.slice(1), jsonFlag, fail, output });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (e) {
    const jsonFlag = process.argv.includes('--json');
    if (jsonFlag) console.log(JSON.stringify({ ok: false, message: e.message }, null, 2));
    else console.error(`未预期错误：${e.message}`);
    process.exit(EXIT.UNEXPECTED);
  }
}
