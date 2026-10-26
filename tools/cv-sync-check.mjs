#!/usr/bin/env node

/**
 * cv-sync-check.mjs — Validates that the career-ops setup is consistent.
 *
 * Checks:
 * 1. cv.md exists
 * 2. config/profile.yml exists and has required fields
 * 3. No hardcoded metrics in _shared.md or batch/batch-prompt.md
 * 4. article-digest.md freshness (if exists)
 * 5. Per-track CV variants (cv-*.md) state no fact that cv.md does not
 * 6. Fact ledger: 存疑 claims still in use, cv.md claims with no ledger entry
 *
 * Check 5 is the background-check guard. Since 2026-10-10 the system runs two
 * job-search directions and keeps a reworded CV per direction (cv-auto.md for the
 * automotive tracks — see the CV source table in modes/_profile.md). A variant may
 * rephrase, retitle, reorder, drop, and re-weight freely. It may NOT introduce an
 * employer, a date or a number that cv.md does not contain: Chinese employers do
 * run background checks, and a discrepancy between two CVs the same candidate sent
 * out is the worst possible way to fail one. So:
 *
 *   fact(variant) ⊆ fact(cv.md)   → OK   (trimming and rewording are the point)
 *   fact(variant) ⊄ fact(cv.md)   → ERROR (a fact was invented)
 *
 * Check 6 reads the fact ledger (cv-evolve/ledger.yml, see modes/evolve.md) and only
 * ever warns: claims still in a CV while the ledger marks them 存疑, and claims in
 * cv.md the ledger has no entry for. The ledger annotates cv.md; it never blocks it.
 *
 * The converse is deliberately not an error: cv.md having facts a variant omits is
 * exactly what tailoring means.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractNumbers, extractClaims, textContainsClaim, readLedger } from './cv-facts.mjs';

// Script lives in tools/; project root is one level up.
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const warnings = [];
const errors = [];

// 1. Check cv.md exists
const cvPath = join(projectRoot, 'cv.md');
if (!existsSync(cvPath)) {
  errors.push('cv.md not found in project root. Create it with your CV in markdown format.');
} else {
  const cvContent = readFileSync(cvPath, 'utf-8');
  if (cvContent.trim().length < 100) {
    warnings.push('cv.md seems too short. Make sure it contains your full CV.');
  }
}

// 2. Check profile.yml exists
const profilePath = join(projectRoot, 'config', 'profile.yml');
if (!existsSync(profilePath)) {
  errors.push('config/profile.yml not found. Copy from config/profile.example.yml and fill in your details.');
} else {
  const profileContent = readFileSync(profilePath, 'utf-8');
  const requiredFields = ['full_name', 'email', 'location'];
  for (const field of requiredFields) {
    if (!profileContent.includes(field) || profileContent.includes(`"Jane Smith"`)) {
      warnings.push(`config/profile.yml may still have example data. Check field: ${field}`);
      break;
    }
  }
}

// 3. Check for hardcoded metrics in prompt files
const filesToCheck = [
  { path: join(projectRoot, 'modes', '_shared.md'), name: '_shared.md' },
  { path: join(projectRoot, 'batch', 'batch-prompt.md'), name: 'batch-prompt.md' },
];

// Pattern: numbers that look like hardcoded metrics (e.g., "170+ hours", "90% self-service")
const metricPattern = /\b\d{2,4}\+?\s*(hours?|%|evals?|layers?|tests?|fields?|bases?)\b/gi;

for (const { path, name } of filesToCheck) {
  if (!existsSync(path)) continue;
  const content = readFileSync(path, 'utf-8');

  // Skip lines that are clearly instructions (contain "NEVER hardcode" etc.)
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('NEVER hardcode') || line.includes('NUNCA hardcode') || line.startsWith('#') || line.startsWith('<!--')) continue;
    const matches = line.match(metricPattern);
    if (matches) {
      warnings.push(`${name}:${i + 1} — Possible hardcoded metric: "${matches[0]}". Should this be read from cv.md/article-digest.md?`);
    }
  }
}

// 4. Check article-digest.md freshness
const digestPath = join(projectRoot, 'article-digest.md');
if (existsSync(digestPath)) {
  const stats = statSync(digestPath);
  const daysSinceModified = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
  if (daysSinceModified > 30) {
    warnings.push(`article-digest.md is ${Math.round(daysSinceModified)} days old. Consider updating if your projects have new metrics.`);
  }
}

// 5. Per-track CV variants must not invent facts
//
// Two fact families are compared, both chosen because they are mechanically
// extractable from this CV format rather than guessed at:
//
//   numbers — every digit run (extractNumbers, tools/cv-facts.mjs). Covers dates (2024.08), durations, headcounts,
//             percentages, test counts. Normalized so "90 %" == "90%" and
//             "1,200" == "1200", and split on separators so "173/173" yields 173.
//   heading segments — work/education/project headings are written as
//             `### 2024.03 – 2024.08｜Employer｜Dept｜Title`, so the ｜-delimited
//             segments are the employer / school / project names. Matching them
//             as a set catches an invented employer, which a number scan cannot.
//             Only headings that actually carry a ｜ are treated as fact records;
//             a plain heading like `## 专业摘要` is section structure, and a
//             variant is free to add, drop or rename sections. Those are reported
//             as info, not errors — flagging them was a false positive in practice.
// H1 is deliberately excluded: it is the document title (name + target role), and
// retargeting the role is precisely what a per-track variant is for.
//
// Returns { records, sections }: `records` are the identity-bearing segments of
// delimited headings (facts); `sections` are undelimited headings (structure).
function extractHeadings(text) {
  const records = new Set();
  const sections = new Set();
  const norm = seg => seg.replace(/[\s　]+/g, '').replace(/[—–-]/g, '-').trim();

  for (const line of text.split('\n')) {
    if (!/^#{2,6}\s/.test(line)) continue;
    const body = line.replace(/^#{2,6}\s*/, '');
    if (/[｜|]/.test(body)) {
      for (const seg of body.split(/[｜|]/)) {
        const n = norm(seg);
        if (n.length >= 2) records.add(n);
      }
    } else {
      const n = norm(body);
      if (n.length >= 2) sections.add(n);
    }
  }
  return { records, sections };
}

const canonicalCvPath = join(projectRoot, 'cv.md');
if (existsSync(canonicalCvPath)) {
  const canonical = readFileSync(canonicalCvPath, 'utf-8');
  const canonNumbers = extractNumbers(canonical);
  const { records: canonRecords, sections: canonSections } = extractHeadings(canonical);

  const variants = readdirSync(projectRoot)
    .filter(f => /^cv-.+\.md$/.test(f))
    .sort();

  if (variants.length === 0) {
    console.log('(no per-track CV variants found — check 5 skipped)');
  }

  for (const file of variants) {
    const text = readFileSync(join(projectRoot, file), 'utf-8');

    const varNumbers = extractNumbers(text);
    const { records: varRecords, sections: varSections } = extractHeadings(text);

    const newNumbers = [...varNumbers].filter(n => !canonNumbers.has(n));
    const newRecords = [...varRecords].filter(sg => !canonRecords.has(sg));
    const newSections = [...varSections].filter(sg => !canonSections.has(sg));

    for (const n of newNumbers) {
      errors.push(`${file} states the number "${n}", which does not appear in cv.md. `
        + `A variant may reword and drop facts, never add them — either fix the variant or add the fact to cv.md first.`);
    }
    for (const sg of newRecords) {
      errors.push(`${file} claims "${sg}" in an employer/project heading, and cv.md has no such heading segment. `
        + `If it is real, add it to cv.md (the canonical fact layer) first.`);
    }

    if (newNumbers.length === 0 && newRecords.length === 0) {
      const droppedN = [...canonNumbers].filter(n => !varNumbers.has(n)).length;
      console.log(`${file}: facts consistent with cv.md `
        + `(${droppedN} canonical number(s) omitted — trimming is allowed)`);
      if (newSections.length) {
        console.log(`  (new section heading(s), fine: ${newSections.join(', ')})`);
      }
    }
  }
}

// 6. Fact ledger (only once the candidate has run /career-ops evolve init)
const ledger = readLedger();
if (ledger && existsSync(canonicalCvPath)) {
  const cvFiles = ['cv.md', ...readdirSync(projectRoot).filter(f => /^cv-.+\.md$/.test(f)).sort()];
  const texts = Object.fromEntries(cvFiles.map(f => [f, readFileSync(join(projectRoot, f), 'utf-8')]));

  for (const e of ledger.filter(e => e.status === '存疑' && e.claim)) {
    for (const claim of extractClaims(e.claim)) {
      const using = cvFiles.filter(f => textContainsClaim(texts[f], claim));
      if (using.length) {
        warnings.push(`ledger ${e.id}: "${claim}" is marked 存疑 (${e.source || 'no source'}) but still appears in ${using.join(', ')}. `
          + `Fix the number or its wording before generating more tailored CVs — run /career-ops evolve.`);
      }
    }
  }

  const covered = new Set(ledger.flatMap(e => [...extractClaims(e.claim || '')]));
  const uncovered = [...extractClaims(texts['cv.md'])].filter(c => !covered.has(c));
  if (uncovered.length) {
    warnings.push(`cv.md has ${uncovered.length} claim(s) with no ledger entry: ${uncovered.slice(0, 8).join(', ')}`
      + `${uncovered.length > 8 ? ', …' : ''}. Their provenance is unrecorded — /career-ops evolve init can backfill them.`);
  }
}

// Output results
console.log('\n=== career-ops sync check ===\n');

if (errors.length === 0 && warnings.length === 0) {
  console.log('All checks passed.');
} else {
  if (errors.length > 0) {
    console.log(`ERRORS (${errors.length}):`);
    errors.forEach(e => console.log(`  ERROR: ${e}`));
  }
  if (warnings.length > 0) {
    console.log(`\nWARNINGS (${warnings.length}):`);
    warnings.forEach(w => console.log(`  WARN: ${w}`));
  }
}

console.log('');
process.exit(errors.length > 0 ? 1 : 0);
