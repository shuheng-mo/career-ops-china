// Pack 渲染与冻结（spec §7）：draft 从活动块渲染；freeze 落块级快照；
// 冻结后渲染只读快照——历史 pack 不被后续知识库变化覆盖。
import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRoot, atomicWriteJson } from '../core/storage.mjs';
import { ValidationError } from '../core/validation.mjs';
import { splitFrontMatter } from '../core/yaml.mjs';
import { readBlockById, blockFilePath } from '../core/blocks.mjs';

function packDir(root, packId) {
  if (!/^pack-[a-f0-9]{12}$/.test(String(packId))) {
    throw new ValidationError(`非法 pack id：${packId}`);
  }
  const { paths } = resolveRoot(root);
  return join(paths.packsDir, packId);
}

function readPack(root, packId) {
  const f = join(packDir(root, packId), 'pack.json');
  if (!existsSync(f)) throw new ValidationError(`pack 不存在：${packId}`);
  return JSON.parse(readFileSync(f, 'utf8'));
}

export function freezePack(root, packId) {
  const dir = packDir(root, packId);
  const pack = readPack(root, packId);
  if (pack.status === 'frozen') return { idempotent: true };
  if (pack.status !== 'draft') throw new ValidationError(`pack ${packId} 状态为 ${pack.status}，只有 draft 可 freeze`);
  // 快照：selected + hard_gates 的块文件原样复制
  mkdirSync(join(dir, 'snapshot'), { recursive: true });
  const ids = [...pack.selected_blocks.map((b) => b.id), ...pack.hard_gates.map((g) => g.id)];
  for (const id of ids) {
    const src = blockFilePath(root, id);
    if (existsSync(src)) copyFileSync(src, join(dir, 'snapshot', `${id}.md`));
  }
  pack.status = 'frozen';
  atomicWriteJson(join(dir, 'pack.json'), pack);
  return { idempotent: false };
}

function snapshotBlockContent(root, pack, blockId) {
  const snap = join(packDir(root, pack.pack_id), 'snapshot', `${blockId}.md`);
  if (pack.status === 'frozen' && existsSync(snap)) return readFileSync(snap, 'utf8');
  const blk = readBlockById(root, blockId);
  if (!blk) return null;
  return `---\n${yamlDump(blk.frontMatter)}---\n${blk.body}`;
}

import YAML from 'yaml';
function yamlDump(frontMatter) {
  return YAML.stringify(frontMatter, { lineWidth: 0 });
}

function firstSection(body, name) {
  const m = body.match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return m ? m[1].trim() : '';
}

export function renderPack(root, packId) {
  const pack = readPack(root, packId);
  const dir = packDir(root, packId);
  const lines = [];
  lines.push(`# 面试包 — ${'application #' + pack.application_num} ${pack.round || ''}`);
  lines.push('');
  lines.push(`**知识库版本：** ${pack.kb_revision} · **生成：** ${pack.created_at} · **状态：** ${pack.status} · **预算：** ${pack.prep_minutes} 分钟`);
  lines.push(`**CV：** ${pack.cv_source}${pack.cv_snapshot_hash ? `（${pack.cv_snapshot_hash.slice(0, 12)}）` : ''}`);
  if (pack.jd_source) lines.push(`**JD 来源：** ${pack.jd_source}`);
  if (pack.report_source) lines.push(`**评估报告：** ${pack.report_source}`);
  lines.push('');

  // 考前一页
  lines.push(`## 考前一页（${pack.prep_minutes} 分钟预算）`, '');
  lines.push('先硬闸门 → 自我介绍 → 高优先级块，时间不足以下未覆盖，不承诺全部掌握。', '');
  for (const b of pack.selected_blocks) {
    const content = snapshotBlockContent(root, pack, b.id);
    if (!content) continue;
    const { frontMatter, body } = splitFrontMatter(content);
    const anchors = (frontMatter.anchors || []).map((a) => `#${a}`).join(' ');
    const sec30 = firstSection(body, '30 秒版');
    lines.push(`- **${b.id}**（${b.estimated_minutes} 分钟）${anchors} — ${sec30.split('\n')[0] || ''}`);
  }
  for (const g of pack.hard_gates) {
    lines.push(`- ⛔ **硬闸门 ${g.id}**：${g.reason}`);
  }
  lines.push('');

  // 硬闸门段
  if (pack.hard_gates.length) {
    lines.push('## ⛔ 硬闸门（先核对口径，再谈练习）', '');
    for (const g of pack.hard_gates) {
      const content = snapshotBlockContent(root, pack, g.id);
      lines.push(`### ${g.id}`, '', g.reason, '');
      if (content) lines.push('<details>快照内容（仅供核对，不得照此作答）', '', '```', content.slice(0, 1200), '```', '', '</details>', '');
    }
  }

  // 知识块正文
  lines.push('## 知识块正文', '');
  for (const b of pack.selected_blocks) {
    const content = snapshotBlockContent(root, pack, b.id);
    if (!content) continue;
    lines.push(`### ${b.id}`, '', splitFrontMatter(content).body.trim(), '');
  }

  // 公司资料 + 前轮反馈（overlays，含 freshness）
  if (pack.overlays.length) {
    lines.push('## 公司资料与前轮反馈', '');
    for (const o of pack.overlays) lines.push(`- ${o}`);
    lines.push('');
    if (pack.research_refs.some((r) => r.freshness !== 'fresh')) {
      lines.push('> ⚠ 资料非 fresh：面试前请重查公司最新动态（融资/产品/组织），以下仅作历史参考。', '');
    }
  }

  // 覆盖缺口
  if (pack.coverage_gaps.length) {
    lines.push('## 覆盖缺口（知识库还没覆盖的高价值问题）', '');
    for (const g of pack.coverage_gaps) lines.push(`- ${g}`);
    lines.push('');
  }

  // 反问建议（模板，不含编造的公司信息）
  lines.push('## 反问建议（模板，按现场调整）', '');
  lines.push('- 团队目前 Agent 落地的最大瓶颈是效果、成本还是工程链路？（结合本包知识块主题追问）');
  lines.push('- 这个岗位前三个月，什么产出算「做对了」？');
  lines.push('- 团队的技术路线里，评估（Eval）和数据治理分别由谁负责、怎么协作？');
  lines.push('');

  // 准备计划
  lines.push('## 准备计划', '');
  let used = 0;
  for (const b of pack.selected_blocks) {
    used += b.estimated_minutes;
    lines.push(`- [ ] ${b.id}（${b.estimated_minutes} 分钟）—— 读完整答案 → 只看锚点复述 → 盲测一次`);
  }
  if (pack.hard_gates.length) {
    lines.push(`- [ ] ⛔ 硬闸门口径核对（${pack.hard_gates.map((g) => g.id).join(', ')}）`);
  }
  lines.push(`- 预算 ${pack.prep_minutes} 分钟，已分配 ${used} 分钟${pack.prep_minutes - used > 0 ? `，剩余 ${pack.prep_minutes - used} 分钟留给覆盖缺口/反问` : ''}`);
  lines.push('');

  // 警示
  if (pack.warnings.length) {
    lines.push('## 降级与警示', '');
    for (const w of pack.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  const md = lines.join('\n');
  writeFileSync(join(dir, '面试包.md'), md);
  return md;
}
