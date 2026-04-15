#!/usr/bin/env node
// Backfill report URLs: replace "bookmarklet 文件 `jd-xxx.json`" refs with the
// actual web URL stored inside that JSON. Run once to clean up existing reports.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS = join(ROOT, "reports");
const INBOX = join(ROOT, "inbox", "processed");

const JSON_REF = /`(jd-\d{8}-\d{6}-[^`]+\.json)`/;
const URL_LINE = /^\*\*URL[：:]\*\*.*$/m;

const reports = readdirSync(REPORTS).filter((f) => f.endsWith(".md"));
let fixed = 0;
let skipped = 0;
let missing = 0;

for (const file of reports) {
  const path = join(REPORTS, file);
  const content = readFileSync(path, "utf8");

  const match = content.match(JSON_REF);
  if (!match) continue;

  const jsonName = match[1];
  const jsonPath = join(INBOX, jsonName);

  let realUrl;
  try {
    const data = JSON.parse(readFileSync(jsonPath, "utf8"));
    realUrl = data.url;
  } catch (err) {
    console.log(`⚠️  ${file}: JSON not found — ${jsonName}`);
    missing++;
    continue;
  }

  if (!realUrl) {
    console.log(`⚠️  ${file}: JSON has no .url field`);
    skipped++;
    continue;
  }

  const newContent = content.replace(URL_LINE, `**URL：** ${realUrl}`);
  if (newContent === content) {
    console.log(`⚠️  ${file}: URL line not matched`);
    skipped++;
    continue;
  }

  writeFileSync(path, newContent);
  console.log(`✅ ${file} → ${realUrl.slice(0, 80)}...`);
  fixed++;
}

console.log(`\n📊 Fixed: ${fixed}, Skipped: ${skipped}, Missing JSON: ${missing}`);
