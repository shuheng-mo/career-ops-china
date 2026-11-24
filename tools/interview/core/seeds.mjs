import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYamlSafe } from './yaml.mjs';

const TEMPLATES_PATH = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'templates', 'interview', 'seed-templates.yml'
);

const FIRST_BATCH_CAP = 10;
const MAX_BOOTSTRAP_PROJECTS = 2;

export function slugifyTitle(title, index) {
  const clean = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const first = String(title).split(/[—–·|]/)[0] || '';
  let base = clean(first);
  if (!base) base = clean(String(title));
  if (!base) base = `proj-${index + 1}`;
  base = base.slice(0, 60).replace(/-+$/g, '');
  return base || `proj-${index + 1}`;
}

export function parseCvProjects(cvText) {
  const projects = [];
  let inSection = false;
  for (const line of String(cvText).split('\n')) {
    if (/^## /.test(line)) inSection = /项目经历|Projects/i.test(line);
    if (!inSection) continue;
    const m = line.match(/^### (.+)$/);
    if (m) projects.push({ title: m[1].trim(), slug: slugifyTitle(m[1], projects.length) });
  }
  return projects;
}

function loadTemplates() {
  const doc = loadYamlSafe(readFileSync(TEMPLATES_PATH, 'utf8'));
  if (!doc || !Array.isArray(doc.templates) || !doc.templates.length) {
    throw new Error(`种子模板文件无效：${TEMPLATES_PATH}`);
  }
  return doc.templates;
}

export function generateSeeds(cvText, { trackIds = ['ai-app'], now = new Date().toISOString() } = {}) {
  const templates = loadTemplates();
  const projects = parseCvProjects(cvText).slice(0, MAX_BOOTSTRAP_PROJECTS);
  const intro = templates.find((t) => t.intent_key === 'intro.self');
  const scoped = templates
    .filter((t) => t.intent_key !== 'intro.self')
    .sort((a, b) => a.priority - b.priority);

  // 展开：intro 优先，随后按项目顺序 × 意图优先级（story→contribution→decision→result→boundary）
  const expansion = [];
  if (intro) expansion.push({ template: intro, project: null });
  for (const proj of projects) {
    for (const t of scoped) expansion.push({ template: t, project: proj });
  }

  const seeds = [];
  for (const { template, project } of expansion) {
    if (seeds.length >= FIRST_BATCH_CAP) break;
    const intentKey = project
      ? template.intent_key.replace('{p}', project.slug)
      : template.intent_key;
    const seed = {
      seed_id: createHash('sha256').update(intentKey).digest('hex').slice(0, 12),
      project_ref: project ? project.slug : null,
      intent_key: intentKey,
      question: template.question.replace('{p}', project ? project.title : '').trim(),
      aliases: [...(template.aliases || [])],
      tracks: [...trackIds],
      rounds: [...(template.rounds || ['technical'])],
      source_refs: [{ artifact_id: 'cv', locator: project ? `project:${project.title}` : 'template' }],
      fact_refs: [],
      origin_kind: 'template',
      status: 'queued',
      missing_fields: [],
      answer_block_id: null,
      created_at: now,
      revision: 1,
    };
    seeds.push(seed);
  }
  return seeds;
}
