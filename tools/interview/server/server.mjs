// Interview Studio 本地 server（spec §8/§10）：
// 只监听 127.0.0.1；随机启动 token；Origin/Host 校验；CSP self；
// 静态资源零 CDN；JSON API 薄封装 core 层（路由在各 task 中追加）。
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from './static.mjs';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'interview-studio');

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// API 路由表：createStudioServer 时绑定 root 的 handlers + registerApi 扩展
import { registerCoreApi } from './api.mjs';
const apiExtensions = [];
export function registerApi(handler) {
  apiExtensions.push(handler);
}

export function randomToken() {
  return randomBytes(16).toString('hex');
}

function cookieTokenOf(header) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === 'studio-token') return part.slice(i + 1).trim();
  }
  return undefined;
}

export function createStudioServer(root, { port = 8790, token = randomToken(), host = '127.0.0.1' } = {}) {
  const apiHandlers = [...apiExtensions.map((f) => f(root)), registerCoreApi(root)];
  let boundPort = port; // port=0 时由 listen 回调回填实际端口（Origin 精确匹配依赖它）
  const server = http.createServer(async (req, res) => {
    try {
    const effPort = boundPort;
    const url = new URL(req.url, `http://127.0.0.1:${effPort}`);
    // Host 必须是 127.0.0.1(:port)
    const hostHeader = (req.headers.host || '').split(':')[0];
    if (hostHeader !== '127.0.0.1' && hostHeader !== 'localhost') {
      return json(res, 403, { ok: false, message: '非本机 Host，已拒绝' });
    }
    // Origin 出现时必须是同源（本服务自身，两种本机拼写精确等值）——先于 token 校验
    const origin = req.headers.origin;
    const allowedOrigins = [`http://127.0.0.1:${effPort}`, `http://localhost:${effPort}`];
    if (origin && !allowedOrigins.includes(origin)) {
      return json(res, 403, { ok: false, message: '跨源请求已拒绝' });
    }
    // token：查询参数、X-Studio-Token 头或首访种的 cookie（浏览器加载子资源不带 query）
    const supplied = url.searchParams.get('token') || req.headers['x-studio-token'] || cookieTokenOf(req.headers.cookie);
    if (supplied !== token) {
      return json(res, 401, { ok: false, message: 'token 缺失或不正确（以启动时终端打印的为准）' });
    }

    // API 路由
    if (url.pathname.startsWith('/api/')) {
      for (const handler of apiHandlers) {
        const handled = await handler({ req, res, url, root, token });
        if (handled) return;
      }
      return json(res, 404, { ok: false, message: `未知 API：${url.pathname}` });
    }

    // 静态资源
    const r = serveStatic(APP_DIR, url.pathname);
    if (r.status === 200) {
      const headers = {
        'Content-Type': r.contentType,
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      };
      if (url.searchParams.get('token') === token) {
        headers['Set-Cookie'] = `studio-token=${token}; Path=/; HttpOnly; SameSite=Strict`;
      }
      res.writeHead(200, headers);
      res.end(r.body);
    } else {
      res.writeHead(r.status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(r.body);
    }
    } catch (e) {
      // 顶层兜底：任何 handler 异常都不允许杀掉 server 进程（spec §10 可靠性）
      try {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: `服务内部错误：${e.message}` }));
      } catch { /* 响应已发出时忽略 */ }
    }
  });
  server.attachWs = (opts) => attachWs(server, { root, ...opts });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      boundPort = server.address().port;
      resolve(server);
    });
  });
}

// WS 采集端点（spec §9，P3 安全模型延续）：/ws/capture?token=
// 协议（JSON）：client→{start:{mode}|pcm:{data base64}|lock:{locked}|stop}；
// server→{state}|{asr event}|{hint}|{error}
import { WebSocketServer } from 'ws';
import { FastPath } from './capture-fastpath.mjs';
import { CaptureSession, STATES as CAP_STATES } from './capture.mjs';
import { createSession, appendEvent } from '../core/sessions.mjs';
import { createMockAsrProvider } from '../providers/asr/mock.mjs';
import { readBlockById } from '../core/blocks.mjs';
import { AliyunFunAsrProvider } from '../providers/asr/aliyun-fun-asr.mjs';

const wsExtensions = []; // createWsHandlers(req, token) → [{type, handler(ws, msg)}] 可扩展
export function registerWs(handler) {
  wsExtensions.push(handler);
}

export function attachWs(server, { token, root, asrConfig, createProvider: createProviderOpt }) {
  const wss = new WebSocketServer({ noServer: true });
  const createProvider = asrConfig?.createProvider
    || createProviderOpt
    || (() => createMockAsrProvider()); // 默认 mock（provider: none/未配置时也可演练）

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const hostHeader = (req.headers.host || '').split(':')[0];
    if (hostHeader !== '127.0.0.1' && hostHeader !== 'localhost') {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    const boundPort = server.address()?.port;
    const allowed = [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`];
    if (origin && !allowed.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws/capture') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.searchParams.get('token') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    let fastPath = null;
    let capture = null;
    let provider = null;
    let practiceSessionId = null;

    const send = (obj) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return send({ type: 'error', message: '消息不是 JSON' }); }
      try {
        if (msg.type === 'start') {
          const mode = ['mock_assisted', 'mock_anchor', 'mock_blind', 'real_record_only'].includes(msg.mode)
            ? msg.mode : 'mock_assisted';
          // 练习 session 落盘（实时链路事件可回放，spec §9.2 append-only）
          const ps = createSession(root, { mode, source: 'studio-voice' });
          practiceSessionId = ps.session_id;
          capture = new CaptureSession({ sessionId: ps.session_id });
          capture.transition(CAP_STATES.permission_pending);
          capture.transition(CAP_STATES.connecting);
          fastPath = new FastPath(root, { mode });
          provider = createProvider(mode);
          await provider.start({ sessionId: ps.session_id, channel: 'mic', sampleRate: 16000 }, async (event) => {
           try {
            send({ type: 'asr', event });
            // final 转写落盘：完整文字记录（partial 是预览态不提交事实，spec §9）
            if (event.type === 'final' && event.text) {
              try {
                appendEvent(root, ps.session_id, {
                  type: 'asr.final',
                  payload: {
                    provider: event.provider, streamId: event.streamId, channel: event.channel,
                    segmentId: event.segmentId, revision: event.revision,
                    startMs: event.startMs, endMs: event.endMs, text: event.text,
                  },
                });
              } catch (e) {
                console.warn(`[studio] asr.final 落盘失败（session ${ps.session_id}）：${e.message}`);
              }
            }
            // gap 计入 capture（stop 后随 state 消息上报）
            if (event.type === 'gap') capture?.noteGap();
            const handle = await fastPath.onAsrEvent(event);
            if (handle) {
              // 实时提交落盘（question.detected 带 realtime 标记）
              try {
                appendEvent(root, ps.session_id, {
                  type: 'question.detected',
                  payload: { realtime: true, question_text: handle.questionText, block: handle.blockId || handle.serverBlockId || null, blind: !!handle.blind },
                });
              } catch { /* 落盘失败不阻塞实时链路 */ }
              // 模式闸门已由 FastPath 处理；hint 直接下发
              const hint = { type: 'hint', generationToken: handle.generationToken, questionText: handle.questionText };
              if (handle.blind) {
                hint.blind = true;
              } else {
                hint.decision = handle.decision;
                if (handle.block) hint.block = handle.block;
                if (handle.candidates) hint.candidates = handle.candidates;
                if (handle.blockId) {
                hint.blockId = handle.blockId;
                const blk = readBlockById(root, handle.blockId);
                if (blk) hint.block = { block_id: blk.block_id, frontMatter: blk.frontMatter, body: blk.body };
              }
              }
              send(hint);
            }
           } catch (e) {
            send({ type: 'error', message: `实时链路处理失败：${e.message}` });
           }
          });
          capture.transition(CAP_STATES.recording);
          send({ type: 'state', state: 'recording', mode });
          return;
        }
        if (msg.type === 'pcm') {
          const buf = Buffer.from(msg.data || '', 'base64');
          if (capture && capture.state === CAP_STATES.recording) {
            await provider?.push(buf);
            // 成本闸门（spec §9.3）：到限停云调用，降级文本模式
            if (capture.noteAudioMs(Math.round((buf.length - 4) / 2 / 16000 * 1000)) && provider) {
              send({ type: 'error', code: 'BUDGET_EXCEEDED', message: '已达本场预算上限（90 分钟 / 3 元）：停止云转写，降级文本模式' });
              await provider.finish?.();
              await provider.close();
              provider = null;
            }
          }
          return;
        }
        if (msg.type === 'lock') {
          fastPath?.setLocked(!!msg.locked);
          send({ type: 'state', locked: !!msg.locked });
          return;
        }
        if (msg.type === 'stop') {
          if (capture && capture.state === 'finished') {
            send({ type: 'state', state: 'finished', gaps: capture.gapCount || 0 });
            return;
          }
          capture?.transition(CAP_STATES.stopping);
          await provider?.finish();
          await provider?.close();
          await capture?.stop();
          send({ type: 'state', state: 'finished', gaps: capture?.gapCount || 0 });
          return;
        }
        send({ type: 'error', message: `未知消息类型 ${msg.type}` });
      } catch (e) {
        send({ type: 'error', message: e.message });
      }
    });

    ws.on('close', () => {
      // 连接断开：强制资源释放（spec §9.1 停止后释放）
      capture?.stop();
      provider?.close();
      fastPath?.dispose();
    });
  });
  return wss;
}
