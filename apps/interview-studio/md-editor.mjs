// 块正文的结构化编辑（开箱即用：用户编辑纯文本，系统转 md）。
// parseSections：md → [{title, kind, lines}]（kind: p 段落 / list 列表 / quote 引用）
// composeSections：逆向重组（行首语法对用户完全隐藏；行内 ** `` 保留原样——稀疏且剥掉丢强调）
export function parseSections(md) {
  const sections = [];
  let cur = null;
  const push = (title) => { cur = { title, blocks: [] }; sections.push(cur); };
  push('（开头）');
  let list = null;
  const closeList = () => { list = null; };
  for (const raw of String(md ?? '').split('\n')) {
    const line = raw.trimEnd();
    if (/^###?\s+/.test(line)) { closeList(); push(line.replace(/^#+\s+/, '')); continue; }
    if (/^-{3,}\s*$/.test(line.trim())) { closeList(); continue; }
    if (!line.trim()) { closeList(); continue; }
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      if (!list) { list = { kind: 'list', lines: [] }; cur.blocks.push(list); }
      list.lines.push(li[1]);
      continue;
    }
    closeList();
    const q = line.match(/^>\s?(.*)$/);
    if (q) { cur.blocks.push({ kind: 'quote', lines: [q[1]] }); continue; }
    const p = cur.blocks[cur.blocks.length - 1];
    if (p && p.kind === 'p') p.lines.push(line);
    else cur.blocks.push({ kind: 'p', lines: [line] });
  }
  return sections.filter((s) => s.blocks.length || s.title !== '（开头）');
}

export function composeSections(sections) {
  const out = [];
  for (const s of sections || []) {
    if (s.title && s.title !== '（开头）') out.push(`## ${s.title}`);
    for (const b of s.blocks || []) {
      if (b.kind === 'list') { for (const l of b.lines) out.push(`- ${l}`); }
      else if (b.kind === 'quote') { for (const l of b.lines) out.push(`> ${l}`); }
      else { for (const l of b.lines) out.push(l); }
    }
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

// UI 用：sections → 每 section 一段纯文本（list 行原样、quote 去前缀、段落原样），空行分隔块
export function sectionsToText(sections) {
  return (sections || []).map((s) => {
    const head = s.title && s.title !== '（开头）' ? `【${s.title}】\n` : '';
    return head + (s.blocks || []).map((b) => b.lines.join(b.kind === 'list' ? '\n' : '\n')).join('\n\n');
  }).filter((x) => x.trim()).join('\n\n');
}

// UI 用：纯文本（按【标题】分段，块间空行区分段落/列表行）→ sections → md。
// 约定：section 内以空行分组；组内多行 → 列表（保存时每行加 "- "）；单行组 → 段落。
export function textToMd(text) {
  const sections = [];
  const parts = String(text ?? '').split(/\n(?=【[^】]+】)/);
  for (const part of parts) {
    const m = part.match(/^【([^】]+)】\n?/);
    const title = m ? m[1] : '（开头）';
    const body = part.replace(/^【[^】]+】\n?/, '');
    const groups = body.split(/\n\s*\n/).map((g) => g.split('\n').map((l) => l.trim()).filter(Boolean)).filter((g) => g.length);
    const blocks = groups.map((g) => (g.length > 1 ? { kind: 'list', lines: g } : { kind: 'p', lines: g }));
    sections.push({ title, blocks });
  }
  return composeSections(sections);
}
