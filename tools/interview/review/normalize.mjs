// 逐字稿标准化（spec §5.1）：MD/TXT/SRT/JSON → utterances。
// 纪律：无时间戳保持 null 不编造；角色只认显式标签，禁止按问号推断 interviewer。
const LABELS = [
  [/^(面试官|interviewer)\s*[:：]/, 'interviewer'],
  [/^(候选人|candidate|我)\s*[:：]/, 'candidate'],
];

function roleOf(text) {
  for (const [re, role] of LABELS) {
    if (re.test(text)) return role;
  }
  return 'unknown';
}

function stripLabel(text) {
  return text.replace(/^(面试官|interviewer|候选人|candidate|我)\s*[:：]\s*/, '');
}

let seqCounter = 0;
function makeUtterance(rawText, span, extra = {}) {
  seqCounter += 1;
  return {
    id: `u${String(seqCounter).padStart(3, '0')}`,
    role: extra.role || roleOf(rawText),
    speaker_id: null,
    start_ms: extra.start_ms !== undefined ? extra.start_ms : null,
    end_ms: extra.end_ms !== undefined ? extra.end_ms : null,
    raw_text: stripLabel(rawText.trim()),
    source_span: span,
  };
}

function parseMdOrTxt(text) {
  const lines = text.split('\n');
  const utterances = [];
  let buf = [];
  let startLine = 0;
  const flush = (endLine) => {
    const joined = buf.join('\n').trim();
    if (joined) utterances.push(makeUtterance(joined, { line_start: startLine + 1, line_end: endLine }));
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      flush(i);
      startLine = i + 1;
      continue;
    }
    // 带显式说话人标签的行单独成一条（角色是确定性信号，值得按行拆）
    if (LABELS.some(([re]) => re.test(line))) {
      flush(i);
      startLine = i;
      utterances.push(makeUtterance(line, { line_start: i + 1, line_end: i + 1 }));
      startLine = i + 1;
      continue;
    }
    if (!buf.length) startLine = i;
    buf.push(line);
  }
  flush(lines.length);
  return utterances;
}

function srtTimeToMs(ts) {
  const m = ts.trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!m) return null;
  return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
}

function parseSrt(text) {
  const utterances = [];
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  let idx = 1;
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx === -1) continue;
    const [startRaw, endRaw] = lines[timeLineIdx].split('-->');
    const startMs = srtTimeToMs(startRaw);
    const endMs = srtTimeToMs(endRaw);
    const body = lines.slice(timeLineIdx + 1).join('\n').trim();
    if (!body) continue;
    utterances.push(makeUtterance(body, { srt_block: idx }, { start_ms: startMs, end_ms: endMs }));
    idx += 1;
  }
  return utterances;
}

export function normalizeTranscript(text, fmt = 'md') {
  seqCounter = 0;
  const format = String(fmt || 'md').toLowerCase();
  if (format === 'srt') return parseSrt(text);
  if (format === 'json') {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('JSON 逐字稿必须是数组：[{role?, text, start_ms?, end_ms?}]');
    return arr.map((item, i) => makeUtterance(item.text || '', { json_index: i + 1 }, {
      role: item.role || undefined, start_ms: item.start_ms ?? null, end_ms: item.end_ms ?? null,
    }));
  }
  return parseMdOrTxt(text);
}

export function detectFormat(filePath) {
  if (filePath.endsWith('.srt')) return 'srt';
  if (filePath.endsWith('.json')) return 'json';
  return 'md';
}
