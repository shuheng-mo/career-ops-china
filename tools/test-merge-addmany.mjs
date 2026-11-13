#!/usr/bin/env node
// Tests bitable-backend addMany() against a fake lark-cli — no real table is touched.
// Run: npm run test:addmany
import assert from 'node:assert/strict';
import { create } from './backends/bitable-backend.mjs';

const CFG = { bitable: { app_token: 'bascnFAKE', table_id_applications: 'tblFAKE' } };

function fakeLark({ rows = [], failCreateCall = -1 } = {}) {
  const calls = { list: 0, creates: [] };
  const run = (args) => {
    const cmd = args[1];
    if (cmd === '+record-list') {
      calls.list++;
      const fields = ['Num', 'Company', 'Role', 'URL', 'Status'];
      return JSON.stringify({ ok: true, data: {
        fields, data: rows.map(r => fields.map(f => r[f] ?? '')),
        record_id_list: rows.map((_, i) => `rec${i}`), has_more: false,
      } });
    }
    if (cmd === '+record-batch-create') {
      const n = calls.creates.length;
      const payload = JSON.parse(args[args.indexOf('--json') + 1]);
      calls.creates.push(payload.create_records);
      if (n === failCreateCall) throw new Error('91402 fake API failure');
      return JSON.stringify({ ok: true });
    }
    throw new Error(`unexpected lark-cli call: ${args.join(' ')}`);
  };
  return { run, calls };
}

const rec = (num, company, role, extra = {}) =>
  ({ num, date: '2026-11-13', company, role, score: 'N/A', status: 'SKIP', pdf: '❌', report: '—', notes: '', track: 'ai-app', ...extra });

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

await test('lists the table once and batches creates at 200', async () => {
  const { run, calls } = fakeLark();
  const recs = Array.from({ length: 450 }, (_, i) => rec(1000 + i, `公司${i}`, `岗位${i}`));
  const res = await create(CFG, { run }).addMany(recs);
  assert.equal(calls.list, 1);
  assert.deepEqual(calls.creates.map(c => c.length), [200, 200, 50]);
  assert.equal(res.inserted.length, 450);
  assert.equal(res.dups.length + res.failed.length, 0);
});

await test('dedups against the existing table and within the batch', async () => {
  const { run, calls } = fakeLark({ rows: [{ Num: 500, Company: '示例甲公司', Role: 'AI 应用工程师', URL: '', Status: ['Applied'] }] });
  const res = await create(CFG, { run }).addMany([
    rec(900, '示例甲公司', 'AI 应用工程师'),     // already tracked as #500
    rec(901, '示例乙公司', 'Agent 工程师'),
    rec(902, '示例乙公司', 'Agent 工程师'),       // same job twice in one merge
  ]);
  assert.deepEqual(res.dups, [{ index: 0, num: 500 }, { index: 2, num: 901 }]);
  assert.deepEqual(res.inserted, [{ index: 1, num: 901 }]);
  assert.equal(calls.creates.flat().length, 1);
});

await test('a different URL is a different posting, not a dup', async () => {
  const { run } = fakeLark({ rows: [{ Num: 10, Company: '示例丙公司', Role: 'Agent 工程师', URL: 'https://www.zhipin.com/job_detail/aaa.html', Status: ['SKIP'] }] });
  const res = await create(CFG, { run }).addMany([
    rec(11, '示例丙公司', 'Agent 工程师', { url: 'https://www.zhipin.com/job_detail/bbb.html' }),
  ]);
  assert.equal(res.inserted.length, 1);
});

await test('writes select cells as arrays and stamps Closed At on terminal status', async () => {
  const { run, calls } = fakeLark();
  await create(CFG, { run }).addMany([rec(5, 'A', 'r', { status: 'SKIP' }), rec(6, 'B', 'r', { status: 'Evaluated' })]);
  const [skip, evald] = calls.creates[0];
  assert.deepEqual(skip.Status, ['SKIP']);
  assert.deepEqual(skip.Track, ['ai-app']);
  assert.match(skip['Closed At'], /^\d{4}-\d{2}-\d{2} 00:00:00$/);
  assert.equal(evald['Closed At'], undefined);
  assert.equal(skip.Num, 5);
});

await test('a failed request fails only its own slice', async () => {
  const { run } = fakeLark({ failCreateCall: 1 });
  const recs = Array.from({ length: 250 }, (_, i) => rec(2000 + i, `C${i}`, `R${i}`));
  const res = await create(CFG, { run }).addMany(recs);
  assert.equal(res.inserted.length, 200);
  assert.equal(res.failed.length, 50);
  assert.equal(res.failed[0].index, 200);
  assert.match(res.failed[0].error, /91402/);
});

await test('an invalid status is rejected locally, never sent', async () => {
  const { run, calls } = fakeLark();
  const res = await create(CFG, { run }).addMany([rec(7, 'X', 'r', { status: '**Applied**' }), rec(8, 'Y', 'r')]);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].index, 0);
  assert.equal(calls.creates.flat().length, 1);
});

await test('assigns sequential nums when a row has none', async () => {
  const { run } = fakeLark({ rows: [{ Num: 300, Company: 'Z', Role: 'z', URL: '', Status: ['SKIP'] }] });
  const res = await create(CFG, { run }).addMany([rec(0, 'P', 'p'), rec(undefined, 'Q', 'q')]);
  assert.deepEqual(res.inserted.map(r => r.num), [301, 302]);
});

console.log(`\n${passed} passed`);
