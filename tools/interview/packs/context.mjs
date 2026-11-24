// Pack 来源收集（spec §7）：tracker 行 + report + CV hash + 公司资料 freshness + 前轮反馈。
// 数据注入：trackerFile/roundsFile 供测试与离线使用（ADR：与 --root 同模式的隔离旗标）；
// 未注入时走 tracker-backend listApplications()（只读）。
import { existsSync, readFileSync as rf } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoot } from '../core/storage.mjs';
import { ValidationError } from '../core/validation.mjs';


function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function freshnessOf(retrievedAt, now = Date.now()) {
  if (!retrievedAt) return 'unknown';
  const days = (now - new Date(retrievedAt).getTime()) / 86400000;
  if (days > 30) return 'expired';
  if (days > 7) return 'stale';
  return 'fresh';
}

function parseReportFrontMatter(text) {
  const date = (text.match(/\*\*日期：\*\*\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
  const track = (text.match(/\*\*Track：\*\*\s*([a-z-]+)/) || [])[1] || null;
  const url = (text.match(/\*\*URL：\*\*\s*(\S+)/) || [])[1] || null;
  return { date, track, url };
}

function loadTracker(trackerFile, applicationNum) {
  let rows;
  if (trackerFile) {
    rows = JSON.parse(rf(trackerFile, 'utf8'));
  } else {
    // 真实 tracker（只读）：动态 import 避免 P1 测试触发 Bitable/md 读取
    //（同步上下文里无法 await → 由 cli 层保证：未注入 fixtures 时 pack 命令才走到这里，
    //  且 cli 以 --allow-real-tracker 显式开启）
    throw new ValidationError('未提供 --fixtures-tracker，且真实 tracker 读取需 --allow-real-tracker（P2 默认关闭）');
  }
  const row = rows.find((r) => Number(r.num) === Number(applicationNum));
  if (!row) {
    throw new ValidationError(`tracker 中不存在编号 ${applicationNum}（不自行创建）`);
  }
  return row;
}

export function gatherContext(root, { applicationNum, round, trackerFile, roundsFile, reportsDir, cvFile, now = new Date().toISOString() } = {}) {
  const { paths } = resolveRoot(root);
  const warnings = [];
  const row = loadTracker(trackerFile, applicationNum);

  // report 文件：row.report 形如 local:../reports-fixture/xxx.md 或 reports/xxx.md
  let report = { found: false, content: null, path: row.report || null, date: null, track: row.track || null, url: null };
  const reportRel = String(row.report || '').replace(/^local:/, '');
  const reportPath = reportsDir
    ? join(reportsDir, reportRel.split('/').pop())
    : resolve(join(paths.root, '..'), reportRel);
  if (reportRel && existsSync(reportPath)) {
    const content = rf(reportPath, 'utf8');
    const meta = parseReportFrontMatter(content);
    report = { found: true, content, path: reportRel, date: meta.date, track: meta.track || row.track || null, url: meta.url };
  } else if (reportRel) {
    warnings.push(`report 文件缺失：${reportRel}（公司资料降级为空，不编造）`);
  }

  // 公司资料：Block C 段落（逐字引用 report，不生成新信息）
  const research = [];
  if (report.found) {
    const blockC = (report.content.match(/## Block C[^\n]*\n([\s\S]*?)(?=\n## |$)/) || [])[1];
    if (blockC && blockC.trim()) {
      const retrievedAt = report.date || now.slice(0, 10);
      const freshness = freshnessOf(retrievedAt, new Date(now).getTime());
      research.push({
        claim: blockC.trim(),
        source_url: report.url,
        retrieved_at: retrievedAt,
        freshness,
      });
      if (freshness === 'stale') warnings.push('公司资料超过 7 天：面试前建议再查一次最新动态');
      if (freshness === 'expired') warnings.push('公司资料已过期（>30 天）：面试前必须重查，以下内容仅作历史参考');
    }
  }

  // CV：当前 cv.md + hash（不能假装是当时投递版本——显式标注 source）；cvFile 供测试注入
  const cvPath = cvFile || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cv.md');
  let cv;
  if (existsSync(cvPath)) {
    const text = rf(cvPath, 'utf8');
    cv = { source: 'current-cv.md', hash: sha256(text) };
    warnings.push('CV 使用当前版本（非投递时快照）；如当时投递版本不同，以记忆与投递 PDF 为准校对差异');
  } else {
    cv = { source: 'missing', hash: null };
    warnings.push('找不到 cv.md：面试包将不含 CV 校对段');
  }

  // 前轮反馈：注入文件或空（P2.1 不直连 interviews.mjs，避免测试触真实存储）
  let rounds_feedback = [];
  if (roundsFile && existsSync(roundsFile)) {
    rounds_feedback = JSON.parse(rf(roundsFile, 'utf8'));
  } else if (!roundsFile) {
    warnings.push('前轮反馈未提供（--fixtures-rounds 或真实 listRounds 接入为 P2 后续项）');
  }

  return {
    application: {
      num: Number(row.num),
      company: row.company,
      role: row.role,
      track: row.track || report.track || null,
      status: row.status,
      score: row.score || null,
    },
    report,
    cv,
    submitted_pdf: row.pdf === '✅' ? (row.pdf_path || '已投递（路径未记录）') : null,
    research,
    rounds_feedback,
    warnings,
    round: round || null,
    now,
  };
}
