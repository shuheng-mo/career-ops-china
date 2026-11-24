import YAML from 'yaml';

export class YamlSafeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'YamlSafeError';
  }
}

export function loadYamlSafe(text) {
  let doc;
  try {
    doc = YAML.parseDocument(text, { prettyErrors: true, schema: 'core' });
  } catch (e) {
    throw new YamlSafeError(`YAML 解析失败：${String((e && e.message) || e).split('\n')[0]}`);
  }
  if (doc.errors.length) {
    const raw = String(doc.errors[0].message).split('\n')[0];
    if (/Map keys must be unique/i.test(raw)) throw new YamlSafeError(`YAML 存在重复 key：${raw}`);
    throw new YamlSafeError(`YAML 解析失败：${raw}`);
  }
  if (doc.warnings.length) {
    const raw = String(doc.warnings[0].message).split('\n')[0];
    throw new YamlSafeError(`YAML 含未解析或危险的 tag，已拒绝：${raw}`);
  }
  return doc.toJS({ maxAliasCount: 100 });
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontMatter(mdText) {
  const m = FENCE.exec(mdText);
  if (!m) throw new YamlSafeError('缺少 front matter（需要 --- 围栏包裹的 YAML 头）');
  return { frontMatter: loadYamlSafe(m[1]), body: mdText.slice(m[0].length) };
}
