#!/usr/bin/env node
// Interview Studio CLI — npm run interview:kb -- <command> [flags]
// 规格契约见 docs/interview-studio/spec-v0.2.md §11；退出码：0 成功 / 1 未预期 /
// 2 校验失败 / 3 用法错误 / 4 目标不存在。
import { readFileSync, existsSync } from 'node:fs';
import { resolveRoot, safeJoin, PathEscapeError } from './core/storage.mjs';
import { splitFrontMatter, loadYamlSafe, YamlSafeError } from './core/yaml.mjs';
import { assertValid, ValidationError } from './core/validation.mjs';

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
