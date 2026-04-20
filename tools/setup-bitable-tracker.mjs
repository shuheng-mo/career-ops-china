#!/usr/bin/env node
/**
 * setup-bitable-tracker.mjs — Bitable tracker initialization wizard.
 *
 * Offers two paths:
 *   [a] Fully automated (recommended): lark-cli creates the Base + Applications
 *       table with all 10 fields and default views. Zero manual Feishu UI work.
 *   [b] Use existing Bitable: paste an existing Bitable URL → validate schema.
 *
 * Ends by offering to run migration (data/applications.md → Bitable).
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import readline from 'readline';

const CAREER_OPS = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_PATH = join(CAREER_OPS, 'config', 'profile.yml');

const CANONICAL_STATES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'];

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
};

// Full field schema for the Applications table (10 columns).
// Order matters: first element becomes the table's default first column.
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
  ];
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, res));

function run(cmd) {
  try {
    return { stdout: execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), error: null };
  } catch (e) {
    return { stdout: '', error: (e.stderr?.toString() || e.message).trim() };
  }
}

function runOrThrow(cmd, label) {
  const { stdout, error } = run(cmd);
  if (error) throw new Error(`${label} failed:\n${error}`);
  return stdout;
}

function parseLarkJson(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    const m = stdout.match(/[\[{][\s\S]*[\]}]\s*$/);
    if (m) return JSON.parse(m[0]);
    return null;
  }
}

async function main() {
  console.log('=== Feishu Bitable Tracker — Setup Wizard ===\n');

  // 1. Check lark-cli + auth
  const which = run('which lark-cli');
  if (which.error) {
    console.error('❌ lark-cli not found. Install from: https://github.com/larksuite/lark-cli');
    process.exit(1);
  }
  console.log('✅ lark-cli:', which.stdout);

  const auth = run('lark-cli auth status');
  if (auth.error || !/user|bot/.test(auth.stdout)) {
    console.error('❌ lark-cli not authenticated. Run: lark-cli auth login');
    if (auth.error) console.error(auth.error);
    process.exit(1);
  }
  console.log('✅ auth OK\n');

  // 2. Choose path
  console.log('Setup path:');
  console.log('  [a] Fully automated — lark-cli creates Base + Applications table for you (recommended)');
  console.log('  [b] Use existing Bitable — paste URL, wizard validates schema');
  const path = ((await ask('Choose [a/b]: ')).trim().toLowerCase() || 'a').charAt(0);

  let appToken, tableId, baseUrl;

  if (path === 'a') {
    ({ appToken, tableId, baseUrl } = await automatedCreate());
  } else if (path === 'b') {
    ({ appToken, tableId, baseUrl } = await validateExisting());
  } else {
    console.error('Invalid choice. Exiting.');
    rl.close();
    process.exit(1);
  }

  // 3. Write profile.yml
  console.log(`\nWriting config to ${PROFILE_PATH}...`);
  updateProfileBitable(appToken, tableId, baseUrl);
  console.log('✅ profile.yml updated');

  // 4. Offer migration
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
  const createOut = runOrThrow(
    `lark-cli base +base-create --name ${shellEsc(name)}`,
    'base-create'
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

  console.log('\nCreating Applications table + 10 fields...');
  const fields = buildFieldsJson();
  const view = [{ name: 'All', type: 'grid' }];

  const tableOut = runOrThrow(
    `lark-cli base +table-create --base-token ${shellEsc(token)} --name Applications --fields ${shellEsc(JSON.stringify(fields))} --view ${shellEsc(JSON.stringify(view))}`,
    'table-create'
  );
  const tableResp = parseLarkJson(tableOut);
  const table = tableResp?.table || tableResp?.data?.table || tableResp;
  const tableId = table?.table_id || table?.id;
  if (!tableId) {
    console.error('Raw response:\n', tableOut.slice(0, 1000));
    throw new Error('Could not extract table_id from +table-create response');
  }
  console.log(`✅ Applications table created: ${tableId}`);

  // Verify field count
  const fieldListOut = run(`lark-cli base +field-list --base-token ${shellEsc(token)} --table-id ${shellEsc(tableId)}`);
  const parsed = parseLarkJson(fieldListOut.stdout);
  const fieldList = parsed?.items || parsed?.data?.items || parsed?.fields || parsed || [];
  const fieldNames = fieldList.map(f => f.field_name || f.name);
  console.log(`✅ Fields confirmed (${fieldNames.length}): ${fieldNames.join(', ')}\n`);

  return { appToken: token, tableId, baseUrl: url };
}

// ---- Path B: validate existing ----

async function validateExisting() {
  console.log(`\nExpected fields in your existing Bitable:`);
  for (const f of buildFieldsJson()) {
    console.log(`   • ${f.name} (${f.type}${f.style?.type ? `/${f.style.type}` : ''})`);
  }
  console.log('');

  const url = (await ask('Paste the Bitable URL: ')).trim();
  const m = url.match(/\/base\/([A-Za-z0-9]+).*[?&]table=([A-Za-z0-9]+)/);
  if (!m) throw new Error('Could not extract app_token + table_id. Expected /base/XXX?table=tblXXX.');
  const [, appToken, tableId] = m;
  console.log(`   app_token: ${appToken}`);
  console.log(`   table_id:  ${tableId}\n`);

  console.log('Probing schema...');
  const out = runOrThrow(
    `lark-cli base +field-list --base-token ${shellEsc(appToken)} --table-id ${shellEsc(tableId)}`,
    'field-list'
  );
  const parsed = parseLarkJson(out);
  const fields = parsed?.items || parsed?.data?.items || parsed?.fields || parsed || [];
  const have = new Set(fields.map(f => f.field_name || f.name));
  const missing = buildFieldsJson().filter(f => !have.has(f.name));

  if (missing.length > 0) {
    console.warn(`⚠️  Missing fields: ${missing.map(f => f.name).join(', ')}`);
    const cont = (await ask('Continue anyway (migration will partially fail)? [y/N] ')).trim().toLowerCase();
    if (cont !== 'y') {
      console.log('Aborted. Add the missing fields, then re-run.');
      process.exit(1);
    }
  } else {
    console.log(`✅ All ${have.size} fields present`);
  }

  return { appToken, tableId, baseUrl: url };
}

// ---- helpers ----

function shellEsc(s) {
  if (/^[A-Za-z0-9_\-.+=/:@,]+$/.test(s)) return s;
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

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
