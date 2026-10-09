#!/usr/bin/env node
// Sync outreach files → tracker status.
//
// Convention: in `outreach/{NN}-{slug}-{channel}-{date}.md`, when the
// 发送记录 table's "消息 1" row gets a YYYY-MM-DD in the 时间 column,
// upgrade tracker row #NN from Evaluated → Applied.
//
// Rules:
//   - Never downgrade. If the row already moved past Evaluated, do nothing.
//   - Idempotent. Running twice produces no extra changes.
//   - HR 回复 column is NOT auto-parsed — too fragile. Prints a hint
//     so the user can upgrade Responded/Interview manually.
//
// Reads and writes the tracker through tools/tracker-backend.mjs rather than
// editing data/applications.md directly. Two reasons:
//   1. Under `tracker.backend: bitable` the md file is a generated snapshot;
//      writing to it silently lost every change at the next `tracker:export`.
//   2. The previous version indexed raw table cells by position against the
//      old 9-column layout, so after the 11-column migration `cells[9]` was
//      the Report column, not Notes — notes were being written into Report.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listApplications, updateMany, getBackend } from "./tracker-backend.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTREACH = join(ROOT, "outreach");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^(\d{1,3})-([a-z0-9-]+)-(boss|maimai|linkedin|wechat|portal|email)-(\d{4}-\d{2}-\d{2})\.md$/;

// Anything at or past "we reached out" — never walk these back to Applied.
const PAST_EVALUATED = new Set([
  "Applied", "Responded", "Interview", "Offer", "Rejected", "Discarded", "SKIP", "Blocked",
]);

function parseOutreach(path) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes("| 消息 1 |")) continue;
    // cells: ["", "时间", "消息 1", "HR 回复", "备注", ""]
    const cells = line.split("|").map((c) => c.trim());
    const sentDate = cells[1];
    const hrReply = cells[3] || "";
    if (DATE_RE.test(sentDate)) return { sentDate, hrReply };
  }
  return null;
}

const dryRun = process.argv.includes("--dry-run");

const backend = await getBackend();
const apps = await listApplications();
const byNum = new Map(apps.map((a) => [a.num, a]));

const files = readdirSync(OUTREACH).filter((f) => f.endsWith(".md"));
const pending = [];
const hrReplyHints = [];
let noop = 0;
let skipped = 0;

for (const file of files) {
  const m = file.match(FILE_RE);
  if (!m) {
    console.log(`⚠️  ${file}: filename doesn't match {NN}-{slug}-{channel}-{date}.md`);
    skipped++;
    continue;
  }
  const num = parseInt(m[1], 10);
  const channel = m[3];

  const parsed = parseOutreach(join(OUTREACH, file));
  if (!parsed) {
    console.log(`⏭  #${num} (${channel}): 消息 1 时间未填，跳过`);
    noop++;
    continue;
  }

  const row = byNum.get(num);
  if (!row) {
    console.log(`⚠️  #${num}: tracker 没找到对应行`);
    skipped++;
    continue;
  }

  if (PAST_EVALUATED.has(row.status)) {
    console.log(`⏭  #${num}: tracker 已是 ${row.status}（不降级）`);
    if (parsed.hrReply && !["", "待回复"].includes(parsed.hrReply)) {
      hrReplyHints.push(`#${num} HR 回复："${parsed.hrReply}" → 你可能要手动升 Responded/Interview/Rejected`);
    }
    noop++;
    continue;
  }

  if (row.status !== "Evaluated") {
    console.log(`⏭  #${num}: tracker 状态是 ${row.status}（非 Evaluated，不动）`);
    noop++;
    continue;
  }

  const noteRef = `${parsed.sentDate} ${channel} 消息 1 已发（outreach/${file}）`;
  const notes = (row.notes || "").includes(`outreach/${file}`)
    ? row.notes
    : `${noteRef}；${row.notes || ""}`;

  pending.push({ num, status: "Applied", notes });
  console.log(`${dryRun ? "🔍" : "✅"} #${num}: Evaluated → Applied (outreach/${file})`);
}

if (pending.length > 0 && !dryRun) {
  const { updated, missing } = await updateMany(pending);
  if (missing.length) console.log(`⚠️  写入时未找到: ${missing.join(", ")}`);
  console.log(`\n📝 已写入 ${backend.backendName} 后端：${updated} 条`);
  if (backend.backendName === "bitable") {
    console.log("   运行 `npm run tracker:export` 刷新 data/applications.md 快照");
  }
}

console.log(`\n📊 升级: ${pending.length}${dryRun ? "（dry-run，未写入）" : ""}, 无变化: ${noop}, 跳过: ${skipped}`);
if (hrReplyHints.length > 0) {
  console.log(`\n💬 HR 回复提示（脚本不自动升级，请手动告诉 Claude）：`);
  hrReplyHints.forEach((h) => console.log(`   ${h}`));
}
