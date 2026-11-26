// Fast/Slow path（spec §9.2，P3 文本模式复用）：
// - partial 只预览，永不定位
// - final（mic 通道）→ 规则识别问题 → 检索 → generation token + 2000ms 稳定期 → 提交
// - 候选人回答（remote 通道）不触发
// - 用户锁定禁止自动跳；新问题作废旧 token；同块 600ms 防抖；盲测不回传块/decision
import { randomUUID } from 'node:crypto';
import { readBlocks, readBlockById } from '../core/blocks.mjs';
import { buildIndex, search } from '../retrieval/bm25.mjs';
import { decide, autoThresholdFor } from '../retrieval/rank.mjs';
import { runSearch } from './retrieval-service.mjs';

const QUESTION_RE = /[？?]|什么|怎么|为什么|多少|哪|有没有|是不是|讲一下|介绍一下|说说|了解/;
const MIN_JUMP_INTERVAL_MS = 600;
const SETTLE_MS = 2000;

export class FastPath {
  constructor(root, { mode = 'mock_assisted' } = {}) {
    this.root = root;
    this.mode = mode;
    this.locked = false;
    this.index = buildIndex(readBlocks(root).map((b) => ({ block_id: b.block_id, frontMatter: b.frontMatter, body: b.body })));
    this.lastSubmission = null;
    this.lastSubmissionCount = 0;
    this.lastJumpAt = 0;
    this.lastJumpBlockId = null;
    this.currentGenerationToken = null;
    this.suppressed = [];
    this.timers = new Set();
    this.seenFinals = new Set(); // streamId:segmentId:revision —— 同流只提交一次
    this.recentFinalTexts = new Map(); // 归一文本 → {streamId, at}：跨流重放检测（5 秒窗口）
  }

  setLocked(locked) {
    this.locked = !!locked;
  }

  dispose() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // 返回 null（未触发）或 {generationToken, ...}（稳定期后异步提交，此处返回提交句柄）。
  // async：检索经 retrieval-service（embedding hybrid 配置时走远端，失败降级词法）
  async onAsrEvent(event) {
    if (event.type !== 'final') return null; // partial 永不定位
    // 重连去重：同一 (streamId, segmentId, revision) 只提交一次
    const dedupKey = `${event.streamId}:${event.segmentId}:${event.revision}`;
    if (this.seenFinals.has(dedupKey)) return null;
    this.seenFinals.add(dedupKey);
    const text = (event.text || '').trim();
    if (!text) return null;
    // 跨流重放：重连后服务端可能重发旧段（新 streamId 同文本，5 秒窗口）——不重复提交
    const textKey = text.replace(/\s+/g, '');
    const seen = this.recentFinalTexts.get(textKey);
    const nowMs = Date.now();
    if (seen && seen.streamId !== event.streamId && nowMs - seen.at < 5000) {
      return null;
    }
    this.recentFinalTexts.set(textKey, { streamId: event.streamId, at: nowMs });
    // 候选人回答不触发（mic=提问者通道；remote=候选人——单麦练习时提问来自 Studio 文本/脚本）
    if (event.channel === 'remote' || event.channel === 'candidate') return null;
    if (!QUESTION_RE.test(text)) return null;
    // 用户锁定禁止自动跳：必须在返回 handle 之前拦截——server 收到 handle 即向浏览器发 hint，
    // 只靠 scheduleSubmission 的稳定期检查挡不住（真实面试 e2e 实锤：lock 后 hint 照发）
    if (this.locked) {
      this.suppressed.push({ text: text.slice(0, 80), reason: 'locked' });
      return null;
    }

    const { results, threshold, mode: retrievalMode } = await runSearch(this.root, text, { topK: 5 });
    const decision = decide(text, results, { autoThreshold: threshold, mode: retrievalMode });
    const token = randomUUID();
    this.currentGenerationToken = token;
    // 盲测：handle 不携带 decision/块信息（泄漏即违规）
    const handle = this.mode === 'mock_blind'
      ? { generationToken: token, questionText: text, blind: true }
      : { generationToken: token, questionText: text, decision };

    // 盲测：不回传 decision/块；服务端记下命中供 reveal
    if (this.mode === 'mock_blind') {
      this.scheduleSubmission(token, decision, results, text);
      return handle;
    }
    if (decision === 'hit') {
      handle.blockId = results[0].blockId;
    } else if (decision === 'candidates') {
      handle.candidates = results.map((r) => ({ blockId: r.blockId, score: r.score }));
    }
    this.scheduleSubmission(token, decision, results, text);
    return handle;
  }

  scheduleSubmission(token, decision, results, text) {
    // 新问题 → 旧 token 全部作废（延迟提交检查 token）
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (token !== this.currentGenerationToken) return; // 过时丢弃
      if (this.locked) {
        this.suppressed.push({ token, text: text.slice(0, 80), reason: 'locked' });
        return;
      }
      const now = Date.now();
      const topBlockId = decision === 'hit' ? results[0].blockId : null;
      if (topBlockId && topBlockId === this.lastJumpBlockId && now - this.lastJumpAt < MIN_JUMP_INTERVAL_MS) {
        this.suppressed.push({ token, text: text.slice(0, 80), reason: 'debounce' });
        return;
      }
      if (decision === 'hit' && topBlockId) {
        this.lastJumpAt = now;
        this.lastJumpBlockId = topBlockId;
        const blk = readBlockById(this.root, topBlockId);
        const blind = this.mode === 'mock_blind';
        this.lastSubmission = {
          generationToken: token,
          decision: blind ? undefined : decision,
          blind,
          block: blind
            ? undefined
            : (blk ? { block_id: blk.block_id, frontMatter: blk.frontMatter, body: blk.body } : null),
        };
        this.lastSubmissionCount += 1;
        return;
      }
      if (decision === 'candidates' && this.mode !== 'mock_blind') {
        this.lastSubmission = { generationToken: token, decision, candidates: results.map((r) => ({ blockId: r.blockId, score: r.score })) };
        this.lastSubmissionCount += 1;
      }
      // unknown：不提交（实时链路不假装命中）
    }, SETTLE_MS);
    this.timers.add(timer);
  }
}
