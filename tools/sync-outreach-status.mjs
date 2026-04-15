#!/usr/bin/env node
// Sync outreach files → tracker status.
//
// Convention: in `outreach/{NN}-{slug}-{channel}-{date}.md`, when the
// 发送记录 table's "消息 1" row gets a YYYY-MM-DD in the 时间 column,
// upgrade applications.md row #NN from Evaluated → Applied.
//
// Rules:
//   - Never downgrade. If row is already Applied/Responded/Interview/
//     Offer/Rejected/Discarded/SKIP, do nothing.
//   - Idempotent. Running twice produces no extra changes.
//   - HR 回复 column is NOT auto-parsed — too fragile. Prints a hint
//     so the user can upgrade Responded/Interview manually.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTREACH = join(ROOT, "outreach");
const TRACKER = join(ROOT, "data", "applications.md");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^(\d{1,3})-([a-z0-9-]+)-(boss|maimai|linkedin|wechat|portal|email)-(\d{4}-\d{2}-\d{2})\.md$/;

function parseOutreach(path) {
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n");

  // Find the 消息 1 row in the 发送记录 table
  for (const line of lines) {
    if (!line.includes("| 消息 1 |")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // cells: ["", "时间", "消息 1", "HR 回复", "备注", ""]
    const sentDate = cells[1];
    const hrReply = cells[3] || "";
    if (DATE_RE.test(sentDate)) {
      return { sentDate, hrReply };
    }
  }
  return null;
}

function loadTracker() {
  const text = readFileSync(TRACKER, "utf8");
  return { text, lines: text.split("\n") };
}

function findTrackerRow(lines, num) {
  const re = new RegExp(`^\\| ${num} \\|`);
  const idx = lines.findIndex((l) => re.test(l));
  if (idx < 0) return null;
  const cells = lines[idx].split("|").map((c) => c.trim());
  // cells: ["", "#", "Date", "Company", "Role", "Score", "Status", "PDF", "Report", "Notes", ""]
  return { idx, cells };
}

function rebuildRow(cells) {
  return "| " + cells.slice(1, -1).join(" | ") + " |";
}

const TERMINAL = new Set(["Applied", "Responded", "Interview", "Offer", "Rejected", "Discarded", "SKIP"]);

const files = readdirSync(OUTREACH).filter((f) => f.endsWith(".md"));
let upgraded = 0;
let noop = 0;
let skipped = 0;
const hrReplyHints = [];

const tracker = loadTracker();

for (const file of files) {
  const m = file.match(FILE_RE);
  if (!m) {
    console.log(`⚠️  ${file}: filename doesn't match {NN}-{slug}-{channel}-{date}.md`);
    skipped++;
    continue;
  }
  const num = parseInt(m[1], 10);
  const channel = m[3];
  const outreachPath = join(OUTREACH, file);

  const parsed = parseOutreach(outreachPath);
  if (!parsed) {
    console.log(`⏭  #${num} (${channel}): 消息 1 时间未填，跳过`);
    noop++;
    continue;
  }

  const row = findTrackerRow(tracker.lines, num);
  if (!row) {
    console.log(`⚠️  #${num}: tracker 没找到对应行`);
    skipped++;
    continue;
  }

  const status = row.cells[6];
  if (TERMINAL.has(status)) {
    console.log(`⏭  #${num}: tracker 已是 ${status}（不降级）`);
    if (parsed.hrReply && !["", "待回复"].includes(parsed.hrReply)) {
      hrReplyHints.push(`#${num} HR 回复："${parsed.hrReply}" → 你可能要手动升 Responded/Interview/Rejected`);
    }
    noop++;
    continue;
  }

  if (status !== "Evaluated") {
    console.log(`⏭  #${num}: tracker 状态是 ${status}（非 Evaluated，不动）`);
    noop++;
    continue;
  }

  // Upgrade Evaluated → Applied
  row.cells[6] = "Applied";
  const noteRef = `${parsed.sentDate} ${channel} 消息 1 已发（outreach/${file}）`;
  const oldNotes = row.cells[9];
  if (!oldNotes.includes(`outreach/${file}`)) {
    row.cells[9] = `${noteRef}；${oldNotes}`;
  }
  tracker.lines[row.idx] = rebuildRow(row.cells);
  console.log(`✅ #${num}: Evaluated → Applied (outreach/${file})`);
  upgraded++;
}

if (upgraded > 0) {
  writeFileSync(TRACKER, tracker.lines.join("\n"));
}

console.log(`\n📊 升级: ${upgraded}, 无变化: ${noop}, 跳过: ${skipped}`);
if (hrReplyHints.length > 0) {
  console.log(`\n💬 HR 回复提示（脚本不自动升级，请手动告诉 Claude）：`);
  hrReplyHints.forEach((h) => console.log(`   ${h}`));
}
