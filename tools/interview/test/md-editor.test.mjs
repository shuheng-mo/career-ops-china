// 结构化编辑器：md ↔ 纯文本往返（用户不懂 md 语法也能编辑）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSections, composeSections, sectionsToText, textToMd } from '../../../apps/interview-studio/md-editor.mjs';

const MD = '## 30 秒版\n一段概述文字。\n\n## 详细版\n- 要点一\n- 要点二\n> 引用句\n\n## 技术边界\n- 边界一';

test('[ME1] parse：标题/列表/引用/段落正确拆分', () => {
  const s = parseSections(MD);
  assert.equal(s.length, 3);
  assert.equal(s[0].title, '30 秒版');
  assert.deepEqual(s[1].blocks.find((b) => b.kind === 'list').lines, ['要点一', '要点二']);
  assert.equal(s[1].blocks.find((b) => b.kind === 'quote').lines[0], '引用句');
});

test('[ME2] 往返：md → text → md 内容等价（引用降级为段落是有意行为）', () => {
  const md2 = textToMd(sectionsToText(parseSections(MD)));
  const strip = (s) => s.replace(/^[-*>#\s]+/gm, '').replace(/\s+/g, '');
  assert.equal(strip(md2), strip(MD));
  assert.ok(md2.includes('- 要点一\n- 要点二'), '列表结构保留');
  assert.ok(!md2.includes('> '), '引用降级为段落');
});

test('[ME3] 真实块样本往返不丢内容', () => {
  const real = '## 30 秒版\n四个「问题→动作→结果」。**加粗保留**。\n\n## 技术边界\n- 权限（E04）：生成前过滤；**没做 RLS**。\n- 不说工业级。';
  const md2 = textToMd(sectionsToText(parseSections(real)));
  assert.ok(md2.includes('**加粗保留**'), '行内粗体保留');
  assert.ok(md2.includes('- 权限（E04）'), '列表行重组');
  assert.ok(md2.includes('**没做 RLS**'));
});

test('[ME4] 用户新增空行分组：多行组=列表、单行组=段落', () => {
  const md = textToMd('【30 秒版】\n单行段落\n\n第一条\n第二条');
  assert.ok(md.includes('单行段落'));
  assert.ok(md.includes('- 第一条\n- 第二条'), '两行组变列表');
});
