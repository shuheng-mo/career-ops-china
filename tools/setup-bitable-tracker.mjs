#!/usr/bin/env node
/**
 * setup-bitable-tracker.mjs — Bitable tracker initialization wizard.
 *
 * Offers three paths:
 *   [a] Fully automated (recommended): lark-cli creates the Base + Applications
 *       table with all 12 storage fields, 4 formula fields and 4 views.
 *       Zero manual Feishu UI work.
 *   [b] Use existing Bitable: paste an existing Bitable URL → validate schema
 *       (read-only; reports what's missing).
 *   [c] Reconcile an existing table to the current definition: additively create
 *       whatever fields / select options / views the definition has and the live
 *       table lacks. Idempotent — safe to re-run.
 *
 * Why (c) exists: this file is the written-down schema, and for months it had
 * drifted from the live table (it built 11 fields and 1 view; the real table had
 * grown to 14 fields and 4 views by hand). Re-running (a) does NOT fix that — it
 * unconditionally +base-create's a SECOND Base. (c) is the repair entry point.
 *
 * What (c) deliberately does NOT do: delete or redefine anything. Changing a
 * field definition is a high-risk PUT needing --yes, and a formula field's output
 * type is inferred once at creation and can only be changed by dropping and
 * recreating the column. Both are the user's call, not this script's — so (c)
 * prints the command and stops.
 *
 * Path (c) is also available non-interactively, which is how you should drive it
 * from a script or a one-liner:
 *   node tools/setup-bitable-tracker.mjs --reconcile           # preview
 *   node tools/setup-bitable-tracker.mjs --reconcile --apply   # write
 * The wizard's prompts cannot be piped (see reconcileNonInteractive for why).
 *
 * Ends by offering to run migration (data/applications.md → Bitable).
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { runLarkCli as larkCli, parseJsonOut } from './feishu/capabilities.mjs';
import { CANONICAL_STATES, TRACKS } from './tracker-backend.mjs';
import readline from 'readline';

const CAREER_OPS = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_PATH = join(CAREER_OPS, 'config', 'profile.yml');

// Color hints (Feishu single-select hues) — roughly funnel stages green→red
const STATUS_HUES = {
  Evaluated: 'Gray',
  Applied:   'Blue',
  Responded: 'Turquoise',
  Interview: 'Yellow',
  Offer:     'Green',
  Rejected:  'Red',
  Discarded: 'Gray',
  SKIP:      'Gray',
  Blocked:   'Orange',   // active-but-held: visually distinct from the gray dead ends
};

// ---- Schema definition — the single written-down description of the live table ----
//
// Split in two because of a hard ordering constraint: a formula references other
// fields BY NAME, so every field it mentions must already exist. Storage fields go
// in with +table-create; formula fields follow, one +field-create each.

// Storage fields (12). Order matters: the first element becomes the table's
// default first column. `Track` is LAST on purpose — the md snapshot mirrors this
// order, and appending kept all of md-backend's positional indices unchanged.
function buildFieldsJson() {
  return [
    {
      type: 'number',
      name: 'Num',
      style: { type: 'plain', precision: 0, thousands_separator: false },
    },
    {
      type: 'datetime',
      name: 'Date',
      style: { format: 'yyyy-MM-dd' },
    },
    {
      type: 'text',
      name: 'Company',
      style: { type: 'plain' },
    },
    {
      type: 'text',
      name: 'Role',
      style: { type: 'plain' },
    },
    {
      type: 'text',
      name: 'Score',
      style: { type: 'plain' },
    },
    {
      type: 'select',
      name: 'Status',
      multiple: false,
      options: CANONICAL_STATES.map(s => ({ name: s, hue: STATUS_HUES[s] || 'Gray', lightness: 'Light' })),
    },
    {
      type: 'checkbox',
      name: 'PDF',
    },
    {
      type: 'text',
      name: 'URL',
      style: { type: 'url' },
    },
    {
      type: 'text',
      name: 'Report',
      style: { type: 'plain' },
    },
    {
      type: 'text',
      name: 'Notes',
      style: { type: 'plain' },
    },
    {
      type: 'datetime',
      name: 'Closed At',
      style: { format: 'yyyy-MM-dd' },
    },
    {
      // The actual PDF that was sent, not a yes/no. The `PDF` checkbox above only
      // says one was generated; output/ accumulates dozens of them locally and
      // nothing records WHICH version went to WHICH company. Six months later,
      // preparing for an interview, that is the question you need answered.
      type: 'attachment',
      name: 'CV PDF',
    },
    {
      // Track = skill axis × industry axis. Enum defined in tools/tracker-backend.mjs
      // (TRACKS); the narrative table lives in modes/_profile.md. Single-select so
      // Bitable can group and kanban by it; blank is legal and means `ai-app`.
      type: 'select',
      name: 'Track',
      multiple: false,
      // Allowed hues are a closed set the API validates server-side:
      // Red Orange Yellow Lime Green Turquoise Wathet Blue Carmine Purple Gray.
      // "Violet" is NOT among them (it was, and the field-create was rejected
      // with 800010701) — the purple one is spelled "Purple".
      options: TRACKS.map(t => ({
        name: t,
        hue: t.includes('auto') ? 'Carmine' : 'Purple',   // automotive vs AI at a glance
        lightness: 'Light',
      })),
    },
  ];
}

// Formula fields (4), in dependency order — `Lifecycle Flag` reads
// `Days Since Added`, so it must be created after it.
//
// ⚠️ A formula field's OUTPUT TYPE is inferred once, at creation, from the leading
// token of the expression, and can never be updated afterwards. Hence the
// deliberate type anchors: `"" &` for text, `0 +` for number. Dropping them makes
// Bitable guess, and a wrongly-typed column can only be fixed by deleting it.
//
// ⚠️ And: view filters silently misbehave on numeric comparisons against formula
// fields (the API accepts the filter and returns the wrong row count). So these
// are for display, sorting and grouping only — every VIEW_SPECS filter below
// targets a natively stored field.
const FORMULA_FIELDS = [
  {
    name: 'Days Since Added',
    expression: '0+IF(ISBLANK([Date]),0,INT(DATEDIF([Date],TODAY(),"D")))',
    why: 'age of the row in days — drives the follow-up nudge in Lifecycle Flag',
  },
  {
    name: 'Score Value',
    // Score is stored as text ("4.2/5"), so sorting it lexicographically puts
    // "10.0/5" before "4.2/5". This is the numeric column to sort and filter on.
    expression: 'ROUND(IFERROR(VALUE(LEFT([Score],3)),0),1)',
    why: 'numeric form of the text Score column, for sorting and dashboards',
  },
  {
    name: 'Direction',
    // Coarse AI-vs-automotive split for funnel grouping. Mirrors
    // trackDirection() in tools/tracker-backend.mjs — keep the two in sync.
    // Enumerated rather than substring-matched so a future track id containing
    // "auto" can't silently change an existing row's direction.
    expression: '""&IF(OR([Track]="ai-app-auto",[Track]="auto-data",[Track]="auto-algo"),"AUTO","AI")',
    why: 'coarse direction (AI | AUTO) for per-direction funnel grouping',
  },
  {
    name: 'Lifecycle Flag',
    // Branches are evaluated in order and must stay mutually exclusive.
    expression: '""&IFS('
      + '[Status]="Interview","🎯 活跃",'
      + '[Status]="Blocked","🧱 待补证据",'
      + 'AND([Status]="Applied",[Days Since Added]>7),"⏰ 该 follow-up",'
      + 'AND([Status]="Responded",[Days Since Added]>7),"⏰ 该 follow-up",'
      + 'AND([Status]="Evaluated",IFERROR(VALUE(LEFT([Score],3)),0)>=4),"🔥 高优待投",'
      + 'NOT(ISBLANK([Closed At])),"🔒 已结束",'
      + 'TRUE(),"—")',
    why: 'the one glanceable column: what needs attention today',
  },
];

// Views (4). Each is created bare (+view-create takes only name + type), then
// configured with the dedicated +view-set-* commands.
const VIEW_SPECS = [
  {
    name: 'All',
    type: 'grid',
    why: 'unfiltered escape hatch — always keep one view that hides nothing',
  },
  {
    name: '待投（Evaluated，按分降序）',
    type: 'grid',
    // `intersects` is the select-field operator; Status is natively stored, so
    // this filter is safe (unlike one over Score Value).
    filter: { logic: 'and', conditions: [['Status', 'intersects', ['Evaluated']]] },
    sort: [{ field: 'Score Value', desc: true }],
    why: 'the work queue: evaluated but not yet acted on, best first',
  },
  {
    name: 'Kanban by Status',
    type: 'kanban',
    group: [{ field: 'Status', desc: false }],
    why: 'funnel at a glance; drag a card to change Status',
  },
  {
    name: '按方向分组（Direction × Track）',
    type: 'grid',
    group: [{ field: 'Direction', desc: false }, { field: 'Track', desc: false }],
    sort: [{ field: 'Score Value', desc: true }],
    why: 'per-direction funnel — the whole point of the Track column',
  },
];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, res));

// Plain shell command (used only for `which lark-cli`).
function run(cmd) {
  try {
    return { stdout: execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), error: null };
  } catch (e) {
    return { stdout: '', error: (e.stderr?.toString() || e.message).trim() };
  }
}

/**
 * Run a lark-cli command through tools/feishu/capabilities.mjs.
 *
 * Takes an argv ARRAY, not a shell string. The previous version concatenated a
 * command line and escaped it by hand, which (a) needed a bespoke shellEsc and
 * (b) passed no --profile — so setup could create a Base in whichever tenant
 * the CLI's global default profile happened to point at.
 */
function lark(args, { write = false } = {}) {
  try {
    return { stdout: larkCli(args, { write, timeoutMs: 60000 }), error: null };
  } catch (e) {
    return { stdout: '', error: e.message };
  }
}

function larkOrThrow(args, label, opts) {
  const { stdout, error } = lark(args, opts);
  if (error) throw new Error(`${label} failed:\n${error}`);
  return stdout;
}

function parseLarkJson(stdout) {
  // Shared parser: tolerates the multi-line diagnostic headers some lark-cli
  // commands print before the JSON payload. Returns null instead of throwing
  // because setup probes responses whose shape it is not sure about.
  try {
    return parseJsonOut(stdout);
  } catch {
    return null;
  }
}

/**
 * Non-interactive reconcile: `--reconcile` (preview) / `--reconcile --apply` (write).
 *
 * Exists because the wizard below is genuinely interactive-only. readline fires a
 * 'line' event as soon as piped data arrives, while rl.question registers a
 * one-shot listener — so any line that lands while no question is pending is
 * silently dropped. With an `await` between two questions (there is one: the
 * config import), piping answers in makes the second question never resolve and
 * node exits 0 having done nothing. Rather than ask anyone to time their stdin,
 * the repair path gets a real flag.
 *
 * Preview is the default and `--apply` is required to write, matching
 * tools/backfill-track.mjs.
 */
async function reconcileNonInteractive() {
  const apply = process.argv.includes('--apply');
  console.log(`=== Reconcile Bitable schema${apply ? '' : '（预览，不写入）'} ===\n`);

  const { readProfileTracker } = await import('./tracker-backend.mjs');
  const cfg = readProfileTracker();
  const appToken = cfg.bitable?.app_token;
  const tableId = cfg.bitable?.table_id_applications;
  if (!appToken || !tableId) {
    console.error('❌ config/profile.yml 的 tracker.bitable.app_token / table_id_applications 未配置。');
    process.exit(1);
  }
  console.log(`app_token: ${appToken}`);
  console.log(`table_id:  ${tableId}\n`);

  const liveFields = listFields(appToken, tableId);
  if (liveFields.length === 0) {
    console.error('❌ 读不到字段列表。检查 token、table id，以及 `lark-cli auth status --profile <p> --json --verify`。');
    process.exit(1);
  }
  const liveNames = new Set(liveFields.map(f => f.field_name || f.name));
  const liveViews = listViews(appToken, tableId);
  const viewsByName = new Map(liveViews.map(v => [v.view_name || v.name, v.view_id || v.id]));

  const wantStorage = buildFieldsJson();
  const missingStorage = wantStorage.filter(f => !liveNames.has(f.name));
  const missingFormula = FORMULA_FIELDS.filter(f => !liveNames.has(f.name));
  const missingViews = VIEW_SPECS.filter(v => !viewsByName.has(v.name));

  console.log(`线上：${liveFields.length} 字段 / ${liveViews.length} 视图`);
  console.log(`定义：${wantStorage.length} 存储字段 + ${FORMULA_FIELDS.length} 公式字段 / ${VIEW_SPECS.length} 视图\n`);

  if (missingStorage.length) {
    console.log('将新建存储字段：');
    for (const f of missingStorage) console.log(`   + ${f.name} (${f.type})`);
  }
  if (missingFormula.length) {
    console.log('将新建公式字段：');
    for (const f of missingFormula) console.log(`   + ${f.name} — ${f.why}`);
  }
  if (missingViews.length) {
    console.log('将新建视图：');
    for (const v of missingViews) console.log(`   + ${v.name} (${v.type}) — ${v.why}`);
  }
  console.log('视图配置（分组/排序/筛选）会对全部 4 个视图重新应用一遍 —— 声明式，匹配时是空操作。');

  // Fields the table has that this file doesn't define. Reported, never touched.
  const definedNames = new Set([...wantStorage.map(f => f.name), ...FORMULA_FIELDS.map(f => f.name)]);
  const extra = [...liveNames].filter(n => !definedNames.has(n));
  if (extra.length) {
    console.log(`\nℹ️  线上有 ${extra.length} 个本文件未定义的字段，原样不动：${extra.join(', ')}`);
  }

  const nothingToDo = missingStorage.length + missingFormula.length + missingViews.length === 0;

  if (!apply) {
    console.log(nothingToDo
      ? '\n✅ 字段和视图都已齐全（视图配置仍可能有漂移，--apply 会重新应用）。'
      : '\n预览结束，未写入。');
    reportMissingSelectOptions(appToken, tableId, liveFields);
    console.log('\n要执行：node tools/setup-bitable-tracker.mjs --reconcile --apply');
    process.exit(0);
  }

  if (missingStorage.length) {
    console.log('\n创建存储字段...');
    for (const f of missingStorage) {
      process.stdout.write(`   + "${f.name}" (${f.type}) … `);
      const { error } = lark([
        'base', '+field-create',
        '--base-token', appToken, '--table-id', tableId,
        '--json', JSON.stringify(f),
      ], { write: true });
      console.log(error ? `❌\n     ${error.split('\n')[0]}` : '✅');
    }
  }
  if (missingFormula.length) {
    console.log('\n创建公式字段...');
    createFormulaFields(appToken, tableId, liveNames);
  }
  console.log('\n同步视图...');
  syncViews(appToken, tableId, viewsByName);

  const optionGaps = reportMissingSelectOptions(appToken, tableId, listFields(appToken, tableId));
  if (optionGaps === 0) console.log('\n✅ select 选项齐全。');

  console.log(`\n✅ 现在：${listFieldNames(appToken, tableId).length} 字段 / ${listViews(appToken, tableId).length} 视图`);
  console.log('   刷新本地快照：npm run tracker:export');
}

async function main() {
  if (process.argv.includes('--reconcile')) {
    rl.close();
    return reconcileNonInteractive();
  }

  console.log('=== Feishu Bitable Tracker — Setup Wizard ===\n');

  // 1. Check lark-cli + auth (probe the binary directly — cross-platform, no `which`)
  const probe = spawnSync('lark-cli', ['--version'], { encoding: 'utf-8' });
  if (probe.error || probe.status !== 0) {
    console.error('❌ lark-cli not found. Install from: https://github.com/larksuite/lark-cli');
    process.exit(1);
  }
  console.log('✅ lark-cli:', (probe.stdout || '').trim() || 'ok');

  const auth = lark(['auth', 'status'], {});
  // Match the parsed payload, not a substring: the words "user" and "bot" also
  // appear in help and error text, so a loose test passes on a failed probe.
  const authOk = !auth.error && (() => {
    const d = parseLarkJson(auth.stdout);
    return d?.identities?.user?.available === true || d?.identities?.bot?.available === true;
  })();
  if (!authOk) {
    console.error('❌ lark-cli not authenticated. Run: lark-cli auth login');
    if (auth.error) console.error(auth.error);
    process.exit(1);
  }
  console.log('✅ auth OK\n');

  // 2. Choose path
  console.log('Setup path:');
  console.log('  [a] Fully automated — lark-cli creates Base + Applications table for you (recommended)');
  console.log('  [b] Use existing Bitable — paste URL, wizard validates schema (read-only)');
  console.log('  [c] Reconcile existing Bitable — additively bring it up to the current definition');
  const path = ((await ask('Choose [a/b/c]: ')).trim().toLowerCase() || 'a').charAt(0);

  let appToken, tableId, baseUrl;

  if (path === 'a') {
    ({ appToken, tableId, baseUrl } = await automatedCreate());
  } else if (path === 'b') {
    ({ appToken, tableId, baseUrl } = await validateExisting());
  } else if (path === 'c') {
    ({ appToken, tableId, baseUrl } = await reconcileExisting());
  } else {
    console.error('Invalid choice. Exiting.');
    rl.close();
    process.exit(1);
  }

  // 3. Write profile.yml
  console.log(`\nWriting config to ${PROFILE_PATH}...`);
  updateProfileBitable(appToken, tableId, baseUrl);
  console.log('✅ profile.yml updated');

  // 4. Offer migration — but not after a reconcile: that table is already live
  //    and populated, and re-importing the md snapshot into it is never what the
  //    user wants when they came here to fix schema drift.
  if (path === 'c') {
    rl.close();
    console.log('\n' + '='.repeat(60));
    console.log('\n✅ Reconcile complete. Refresh the local snapshot with:');
    console.log('   npm run tracker:export');
    return;
  }

  console.log('\n' + '='.repeat(60));
  const mdRows = await countMdRows();
  console.log(`\nNext: migrate ${mdRows} rows from applications.md → Bitable.`);
  const mig = (await ask('Run migration now? [Y/n] ')).trim().toLowerCase();
  rl.close();

  if (mig !== 'n') {
    console.log('\n> node tools/migrate-tracker-md-to-bitable.mjs\n');
    try {
      execSync(`node ${join(CAREER_OPS, 'tools/migrate-tracker-md-to-bitable.mjs')}`, { stdio: 'inherit' });
    } catch {
      console.error('\n⚠️  Migration exited with errors. Re-run when ready: npm run tracker:migrate');
      process.exit(1);
    }
    console.log('\n✅ Setup complete. Edit profile.yml → tracker.backend: bitable to activate.');
  } else {
    console.log('\nWhen ready:');
    console.log('  npm run tracker:migrate      # copy rows to Bitable');
    console.log('  # Then set `tracker.backend: bitable` in config/profile.yml');
  }
}

// ---- Path A: automated creation ----

async function automatedCreate() {
  const defaultName = 'career-ops Tracker';
  const name = ((await ask(`Base name [${defaultName}]: `)).trim() || defaultName);

  console.log(`\nCreating Base "${name}"...`);
  const createOut = larkOrThrow(
    ['base', '+base-create', '--name', name],
    'base-create', { write: true }
  );
  const created = parseLarkJson(createOut);
  const base = created?.base || created?.data?.base || created;
  const token = base?.app_token || base?.base_token || base?.token;
  const url = base?.url || '';

  if (!token) {
    console.error('Raw response:\n', createOut.slice(0, 1000));
    throw new Error('Could not extract app_token from +base-create response');
  }
  console.log(`✅ Base created: ${token}`);
  if (url) console.log(`   URL: ${url}`);

  console.log(`\nCreating Applications table + ${buildFieldsJson().length} storage fields...`);
  const fields = buildFieldsJson();
  // Only the first view here; the rest need +view-set-* passes, done below.
  const view = [{ name: VIEW_SPECS[0].name, type: VIEW_SPECS[0].type }];

  const tableOut = larkOrThrow(
    ['base', '+table-create', '--base-token', token, '--name', 'Applications',
     '--fields', JSON.stringify(fields), '--view', JSON.stringify(view)],
    'table-create', { write: true }
  );
  const tableResp = parseLarkJson(tableOut);
  const table = tableResp?.table || tableResp?.data?.table || tableResp;
  const tableId = table?.table_id || table?.id;
  if (!tableId) {
    console.error('Raw response:\n', tableOut.slice(0, 1000));
    throw new Error('Could not extract table_id from +table-create response');
  }
  console.log(`✅ Applications table created: ${tableId}`);

  // Formula fields must come after the storage fields they reference.
  createFormulaFields(token, tableId, new Set());
  // View 0 came with the table; configure it and create the other three.
  syncViews(token, tableId, new Map());

  const fieldNames = listFieldNames(token, tableId);
  console.log(`✅ Fields confirmed (${fieldNames.length}): ${fieldNames.join(', ')}\n`);

  return { appToken: token, tableId, baseUrl: url };
}

// ---- shared schema operations (used by path a and path c) ----

/**
 * Read the live field list. Returns [] on failure rather than throwing: callers
 * use this to decide what to create, and a probe failure should surface as a
 * clear downstream error, not an opaque stack trace here.
 */
function listFields(appToken, tableId) {
  const { stdout, error } = lark(['base', '+field-list', '--base-token', appToken, '--table-id', tableId]);
  if (error) return [];
  const parsed = parseLarkJson(stdout);
  // lark-cli returns these under data.fields; the other shapes are defensive.
  const d = parsed?.data || parsed || {};
  return d.fields || d.items || parsed?.items || [];
}

function listFieldNames(appToken, tableId) {
  return listFields(appToken, tableId).map(f => f.field_name || f.name).filter(Boolean);
}

function listViews(appToken, tableId) {
  const { stdout, error } = lark(['base', '+view-list', '--base-token', appToken, '--table-id', tableId]);
  if (error) return [];
  const parsed = parseLarkJson(stdout);
  const d = parsed?.data || parsed || {};
  return d.views || d.items || [];
}

/**
 * Create any FORMULA_FIELDS the table doesn't already have, in dependency order.
 *
 * One +field-create per field rather than a single array call: Lifecycle Flag
 * references Days Since Added, and per-field calls make a failure attributable
 * instead of leaving a half-created array.
 *
 * --i-have-read-guide is required by the CLI for formula fields. It is passed
 * here because the guide (lark-base/references/lark-base-field-formula.md) was
 * actually read when these four expressions were written — in particular its
 * rules on the function whitelist, `=` for equality, and `&` for concatenation.
 */
function createFormulaFields(appToken, tableId, existingNames) {
  for (const f of FORMULA_FIELDS) {
    if (existingNames.has(f.name)) {
      console.log(`   ⏭  formula "${f.name}" already present`);
      continue;
    }
    process.stdout.write(`   + formula "${f.name}" … `);
    const { error } = lark([
      'base', '+field-create',
      '--base-token', appToken,
      '--table-id', tableId,
      '--i-have-read-guide',
      '--json', JSON.stringify({ name: f.name, type: 'formula', expression: f.expression }),
    ], { write: true });
    console.log(error ? `❌\n     ${error.split('\n')[0]}` : '✅');
  }
}

/**
 * Create missing views and (re)apply group / sort / filter config to all of them.
 *
 * Config is applied even to pre-existing views: +view-set-* is declarative, so
 * re-applying is a no-op when it already matches and a repair when it doesn't.
 */
function syncViews(appToken, tableId, existingByName) {
  for (const v of VIEW_SPECS) {
    let viewId = existingByName.get(v.name);
    if (!viewId) {
      process.stdout.write(`   + view "${v.name}" … `);
      const { stdout, error } = lark([
        'base', '+view-create',
        '--base-token', appToken,
        '--table-id', tableId,
        '--json', JSON.stringify({ name: v.name, type: v.type }),
      ], { write: true });
      if (error) {
        console.log(`❌\n     ${error.split('\n')[0]}`);
        continue;
      }
      const parsed = parseLarkJson(stdout);
      viewId = parsed?.data?.view?.view_id || parsed?.data?.view?.id
            || parsed?.view?.view_id || parsed?.data?.id;
      console.log('✅');
    }
    // +view-set-* accept a view NAME as well as an id, so a missing id from an
    // unexpected response shape is not fatal.
    const ref = viewId || v.name;
    applyViewConfig(appToken, tableId, ref, v);
  }
}

function applyViewConfig(appToken, tableId, viewRef, spec) {
  const steps = [];
  if (spec.group)  steps.push(['+view-set-group',  { group_config: spec.group }]);
  if (spec.sort)   steps.push(['+view-set-sort',   { sort_config: spec.sort }]);
  if (spec.filter) steps.push(['+view-set-filter', spec.filter]);

  for (const [cmd, payload] of steps) {
    const { error } = lark([
      'base', cmd,
      '--base-token', appToken,
      '--table-id', tableId,
      '--view-id', viewRef,
      '--json', JSON.stringify(payload),
    ], { write: true });
    if (error) console.log(`     ⚠️  ${cmd} on "${spec.name}": ${error.split('\n')[0]}`);
  }
}

/**
 * Report (but do not fix) select options the definition has and the table lacks.
 *
 * Adding an option means +field-update, which is a high-risk PUT requiring --yes.
 * This script must never self-supply --yes, so it prints the exact command and
 * leaves it to the user. This matters in practice: writing a Status or Track
 * value that has no pre-created option fails outright.
 */
function reportMissingSelectOptions(appToken, tableId, liveFields) {
  const byName = new Map(liveFields.map(f => [f.field_name || f.name, f]));
  let gaps = 0;

  for (const want of buildFieldsJson()) {
    if (want.type !== 'select') continue;
    const live = byName.get(want.name);
    if (!live) continue;   // whole field missing — handled by the caller
    const have = new Set((live.options || live.property?.options || []).map(o => o.name));
    const missing = want.options.filter(o => !have.has(o.name));
    if (missing.length === 0) continue;

    gaps++;
    console.log(`\n   ⚠️  "${want.name}" is missing ${missing.length} option(s): ${missing.map(o => o.name).join(', ')}`);
    console.log('      Adding one is a high-risk field update, so run it yourself:');
    console.log(`      lark-cli base +field-update --base-token ${appToken} --table-id ${tableId} \\`);
    console.log(`        --field-id ${live.id || live.field_id} --as user --yes \\`);
    console.log(`        --json '${JSON.stringify({ name: want.name, type: 'select', multiple: false, options: want.options })}'`);
  }
  return gaps;
}

// ---- Path B: validate existing ----

async function validateExisting() {
  console.log(`\nExpected fields in your existing Bitable:`);
  for (const f of buildFieldsJson()) {
    console.log(`   • ${f.name} (${f.type}${f.style?.type ? `/${f.style.type}` : ''})`);
  }
  for (const f of FORMULA_FIELDS) {
    console.log(`   • ${f.name} (formula) — ${f.why}`);
  }
  console.log('');

  const url = (await ask('Paste the Bitable URL: ')).trim();
  const m = url.match(/\/base\/([A-Za-z0-9]+).*[?&]table=([A-Za-z0-9]+)/);
  if (!m) throw new Error('Could not extract app_token + table_id. Expected /base/XXX?table=tblXXX.');
  const [, appToken, tableId] = m;
  console.log(`   app_token: ${appToken}`);
  console.log(`   table_id:  ${tableId}\n`);

  console.log('Probing schema...');
  const out = larkOrThrow(
    ['base', '+field-list', '--base-token', appToken, '--table-id', tableId],
    'field-list'
  );
  const parsed = parseLarkJson(out);
  const fields = parsed?.items || parsed?.data?.items || parsed?.fields || parsed || [];
  const have = new Set(fields.map(f => f.field_name || f.name));
  const missing = [...buildFieldsJson(), ...FORMULA_FIELDS].filter(f => !have.has(f.name));

  if (missing.length > 0) {
    console.warn(`⚠️  Missing fields: ${missing.map(f => f.name).join(', ')}`);
    console.warn('   Path [c] creates these for you without touching anything else.');
    const cont = (await ask('Continue anyway (migration will partially fail)? [y/N] ')).trim().toLowerCase();
    if (cont !== 'y') {
      console.log('Aborted. Re-run and choose [c] to add them.');
      process.exit(1);
    }
  } else {
    console.log(`✅ All ${have.size} fields present`);
  }

  return { appToken, tableId, baseUrl: url };
}

// ---- Path C: reconcile an existing table to the current definition ----

/**
 * Additively bring a live table up to the schema this file defines.
 *
 * Why this is a separate path and not just "re-run (a)": path (a) calls
 * +base-create unconditionally, which creates a SECOND Base rather than
 * updating the one in profile.yml. (c) is the only safe repair route.
 *
 * Only ever ADDS: missing storage fields, missing formula fields, missing views,
 * and view config. Anything that would redefine or remove an existing column is
 * printed as a command for the user to run, never executed here.
 */
async function reconcileExisting() {
  // Default to whatever profile.yml already points at — the common case is
  // repairing the table this project is live on.
  const cfgMod = await import('./tracker-backend.mjs');
  const cfg = cfgMod.readProfileTracker();
  const cfgToken = cfg.bitable?.app_token || '';
  const cfgTable = cfg.bitable?.table_id_applications || '';

  let appToken = cfgToken;
  let tableId = cfgTable;
  let baseUrl = cfg.bitable?.base_url || '';

  if (cfgToken && cfgTable) {
    console.log(`\nprofile.yml points at:`);
    console.log(`   app_token: ${cfgToken}`);
    console.log(`   table_id:  ${cfgTable}`);
    const useIt = (await ask('Reconcile this table? [Y/n] ')).trim().toLowerCase();
    if (useIt === 'n') { appToken = ''; tableId = ''; }
  }

  if (!appToken || !tableId) {
    const url = (await ask('Paste the Bitable URL: ')).trim();
    const m = url.match(/\/base\/([A-Za-z0-9]+).*[?&]table=([A-Za-z0-9]+)/);
    if (!m) throw new Error('Could not extract app_token + table_id. Expected /base/XXX?table=tblXXX.');
    [, appToken, tableId] = m;
    baseUrl = url;
  }

  console.log('\nProbing live schema...');
  const liveFields = listFields(appToken, tableId);
  if (liveFields.length === 0) {
    throw new Error('Could not read the field list. Check the token, the table id, and `lark-cli auth status`.');
  }
  const liveNames = new Set(liveFields.map(f => f.field_name || f.name));
  const liveViews = listViews(appToken, tableId);
  const viewsByName = new Map(liveViews.map(v => [v.view_name || v.name, v.view_id || v.id]));
  console.log(`   live: ${liveFields.length} fields, ${liveViews.length} views`);

  const wantStorage = buildFieldsJson();
  const missingStorage = wantStorage.filter(f => !liveNames.has(f.name));
  const missingFormula = FORMULA_FIELDS.filter(f => !liveNames.has(f.name));
  const missingViews = VIEW_SPECS.filter(v => !viewsByName.has(v.name));

  console.log(`   definition: ${wantStorage.length} storage + ${FORMULA_FIELDS.length} formula fields, ${VIEW_SPECS.length} views`);
  console.log(`   to create: ${missingStorage.length} storage, ${missingFormula.length} formula, ${missingViews.length} view(s)`);

  // Fields the table has but the definition doesn't mention. Reported, never
  // touched — hand-made columns are legitimate and deleting one loses data.
  const definedNames = new Set([...wantStorage.map(f => f.name), ...FORMULA_FIELDS.map(f => f.name)]);
  const extra = [...liveNames].filter(n => !definedNames.has(n));
  if (extra.length) {
    console.log(`\n   ℹ️  ${extra.length} field(s) exist live but aren't in this file: ${extra.join(', ')}`);
    console.log('      Left untouched. If they are keepers, add them to buildFieldsJson()');
    console.log('      so a fresh setup reproduces them.');
  }

  if (missingStorage.length + missingFormula.length + missingViews.length === 0) {
    console.log('\n✅ Already up to date — nothing to create.');
  } else {
    const go = (await ask('\nProceed with these additions? [Y/n] ')).trim().toLowerCase();
    if (go === 'n') {
      console.log('Aborted. Nothing was changed.');
      process.exit(0);
    }

    if (missingStorage.length) {
      console.log('\nCreating storage fields...');
      for (const f of missingStorage) {
        process.stdout.write(`   + "${f.name}" (${f.type}) … `);
        const { error } = lark([
          'base', '+field-create',
          '--base-token', appToken, '--table-id', tableId,
          '--json', JSON.stringify(f),
        ], { write: true });
        console.log(error ? `❌\n     ${error.split('\n')[0]}` : '✅');
      }
    }

    if (missingFormula.length) {
      console.log('\nCreating formula fields...');
      createFormulaFields(appToken, tableId, liveNames);
    }

    console.log('\nSyncing views...');
    syncViews(appToken, tableId, viewsByName);
  }

  // Select options can't be added without a high-risk update; report them.
  const optionGaps = reportMissingSelectOptions(appToken, tableId, listFields(appToken, tableId));
  if (optionGaps === 0) console.log('\n✅ All select options present.');

  const finalNames = listFieldNames(appToken, tableId);
  const finalViews = listViews(appToken, tableId);
  console.log(`\n✅ Now: ${finalNames.length} fields, ${finalViews.length} views`);

  return { appToken, tableId, baseUrl };
}

// ---- helpers ----

async function countMdRows() {
  const mdMod = await import('./backends/md-backend.mjs');
  const backend = mdMod.create({});
  const apps = await backend.listApplications();
  return apps.length;
}

function updateProfileBitable(appToken, tableId, baseUrl) {
  let content = readFileSync(PROFILE_PATH, 'utf-8');
  const fields = [
    ['app_token', appToken],
    ['table_id_applications', tableId],
    ['base_url', baseUrl || ''],
  ];
  for (const [key, value] of fields) {
    const pattern = new RegExp(`(\\n    ${key}:\\s*)("[^"]*"|[^\\s#]*)(\\s*(?:#.*)?)`, 'm');
    const quoted = `"${String(value).replace(/"/g, '\\"')}"`;
    if (pattern.test(content)) {
      content = content.replace(pattern, `$1${quoted}$3`);
    } else {
      console.warn(`   ⚠️  Could not find "${key}:" line in profile.yml (skipped).`);
    }
  }
  writeFileSync(PROFILE_PATH, content);
}

main().catch(e => {
  console.error('\n❌ Setup failed:', e.message);
  rl.close();
  process.exit(1);
});
