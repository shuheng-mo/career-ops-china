// Interview Studio UI（P3）：hash 路由 + fetch 封装 + escapeHtml。
// 安全：所有动态内容经 esc() 后再进 innerHTML；token 存 sessionStorage 不落盘。
import { parseSections, sectionsToText, textToMd } from './md-editor.mjs';

const TOKEN_KEY = 'studio-token';
// 启动 URL 带 token（CLI 打印的地址）→ 存 sessionStorage 并清掉地址栏，缩短 token 暴露时间
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) {
  sessionStorage.setItem(TOKEN_KEY, urlToken);
  history.replaceState(null, '', location.pathname + location.hash);
}
const token = sessionStorage.getItem(TOKEN_KEY) || '';
const view = document.getElementById('view');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 极简 markdown 渲染（零依赖，CSP self）：先全文 HTML 转义再加格式标签——内容即使含 <script> 也只当文本
function mdRender(src) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(src ?? '').split('\n')) {
    const line = raw.trimEnd();
    if (/^###\s+/.test(line)) { closeList(); out.push(`<h4>${inline(line.replace(/^###\s+/, ''))}</h4>`); continue; }
    if (/^##\s+/.test(line)) { closeList(); out.push(`<h3>${inline(line.replace(/^##\s+/, ''))}</h3>`); continue; }
    if (/^#\s+/.test(line)) { closeList(); out.push(`<h2>${inline(line.replace(/^#\s+/, ''))}</h2>`); continue; }
    if (/^-{3,}$/.test(line.trim())) { closeList(); out.push('<hr>'); continue; }
    if (/^>\s?/.test(line)) { closeList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
    const ol = line.match(/^\d+[.、)]\s+(.*)$/);
    if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('');
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'X-Studio-Token': token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    const t = prompt('请输入启动时终端打印的访问 token：');
    if (t) {
      sessionStorage.setItem(TOKEN_KEY, t);
      location.reload();
    }
    throw new Error('未授权');
  }
  const json = await res.json();
  if (!res.ok || json.ok === false) throw new Error(json.message || `HTTP ${res.status}`);
  return json;
}

// ---------- 页面 ----------

async function pageKb() {
  const [blocksRes, bootRes] = await Promise.all([api('/api/blocks'), api('/api/bootstrap')]);
  const { blocks } = blocksRes;
  const active = blocks.filter((b) => b.status === 'active');
  const drafts = blocks.filter((b) => b.status !== 'active');
  const seeds = (bootRes.seeds || []).filter((s) => s.status === 'queued');
  view.innerHTML = `
    <h1>知识库</h1>
    <p class="muted">建库/深挖/审批走 CLI（对话式流程）：<code>npm run interview:kb -- bootstrap --from cv</code></p>
    <h2>活跃块（${active.length}）</h2>
    <div id="block-list"></div>
    ${drafts.length ? `<h2>非活跃（${drafts.length}）</h2><div class="muted">${drafts.map((b) => esc(b.block_id)).join('、')}</div>` : ''}
    ${seeds.length ? `<h2>待回答种子（${seeds.length}）</h2><ul>${seeds.map((s) => `<li>${esc(s.question)}</li>`).join('')}</ul>` : ''}
    <h2>检索</h2>
    <form id="search-form"><input id="search-q" placeholder="输入面试问题试试定位…" autocomplete="off"><button>定位</button></form>
    <div id="search-result"></div>
    <h2>编辑块</h2>
    <select id="edit-select"><option value="">选择块…</option>${blocks.map((b) => `<option value="${esc(b.block_id)}">${esc(b.block_id)}</option>`).join('')}</select>
    <p class="muted">【小标题】分区；区内空行分组——单行组是段落，多行组每行一条要点。不用写任何语法。</p>
    <textarea id="edit-body" rows="14" placeholder="选块后载入（纯文本，自动转换格式）"></textarea>
    <details style="margin-top:4px"><summary class="muted">预览（保存后的效果）</summary><div id="edit-preview" class="md-body"></div></details>
    <button id="edit-save">保存（走 schema 校验，revision +1）</button>
    <div id="edit-msg"></div>
  `;
  const list = view.querySelector('#block-list');
  list.innerHTML = active.map((b) => `
    <details><summary>${esc(b.block_id)}（${esc(b.kind)} · ${esc(b.criticality)}）</summary>
      <p>${(b.questions || []).map((q) => esc(q)).join('<br>')}</p>
      <p class="muted">锚点：${(b.anchors || []).map((a) => esc('#' + a)).join(' ')}</p>
      <div class="md-body">${mdRender(b.body)}</div>
    </details>`).join('');

  view.querySelector('#search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = view.querySelector('#search-q').value;
    const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
    const box = view.querySelector('#search-result');
    if (r.decision === 'hit') {
      box.innerHTML = `<p>✅ 命中 <b>${esc(r.block.block_id)}</b></p><div class="md-body">${mdRender(r.block.body)}</div>`;
    } else if (r.decision === 'candidates') {
      box.innerHTML = `<p>❓ 候选（不自动跳）：${r.results.map((x) => esc(x.blockId)).join('、')}</p>`;
    } else {
      box.innerHTML = '<p>🚫 未知问题（知识库未覆盖）</p>';
    }
  });

  const sel = view.querySelector('#edit-select');
  const editBody = () => view.querySelector('#edit-body');
  const refreshPreview = () => {
    const pv = view.querySelector('#edit-preview');
    if (pv) pv.innerHTML = mdRender(textToMd(editBody().value));
  };
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    const b = await api(`/api/blocks/${encodeURIComponent(sel.value)}`);
    editBody().value = sectionsToText(parseSections(b.body)); // md → 纯文本（语法隐藏）
    refreshPreview();
  });
  editBody().addEventListener('input', refreshPreview);
  view.querySelector('#edit-save').addEventListener('click', async () => {
    const msg = view.querySelector('#edit-msg');
    try {
      const b = await api(`/api/blocks/${encodeURIComponent(sel.value)}`);
      const r = await api(`/api/blocks/${encodeURIComponent(sel.value)}`, { method: 'POST', body: { frontMatter: b.frontMatter, body: textToMd(editBody().value) } });
      msg.textContent = `✓ 已保存，revision ${r.revision}`;
    } catch (err) {
      msg.textContent = `✗ ${err.message}`;
    }
  });
}

async function pagePacks() {
  const { packs } = await api('/api/packs');
  view.innerHTML = `
    <h1>面试包</h1>
    <p class="muted">编译走 CLI：<code>npm run interview:kb -- pack build --application &lt;num&gt; --round &lt;轮次&gt;</code></p>
    ${packs.length ? packs.map((p) => `
      <details><summary>[${esc(p.status)}] ${esc(p.pack_id)} · #${esc(p.application_num)} · ${esc(p.round || '')}</summary>
        <div class="md-body" id="md-${esc(p.pack_id)}">加载中…</div>
      </details>`).join('') : '<p class="muted">还没有编译过面试包。</p>'}
  `;
  for (const p of packs) {
    api(`/api/packs/${p.pack_id}`).then((r) => {
      const el = view.querySelector(`#md-${CSS.escape(p.pack_id)}`);
      if (el) el.innerHTML = mdRender(r.markdown);
    }).catch(() => {});
  }
}

async function pageHeatmap() {
  const stats = await api('/api/stats');
  view.innerHTML = `
    <h1>Heatmap</h1>
    <p>${stats.real_samples === 0 ? '🚫 暂无真实面试样本（频率/掌握度为 null，预测信号不填补热度）' : `真实样本 ${stats.real_samples} 场`}</p>
    ${stats.note ? `<p class="muted">${esc(stats.note)}</p>` : ''}
    <table><thead><tr><th>块</th><th>频率</th><th>掌握</th><th>辅助掌握</th><th>优先级</th><th>状态</th></tr></thead>
    <tbody>
    ${stats.blocks.map((b) => `<tr>
      <td>${esc(b.block_id)}</td>
      <td>${pct(b.frequency)}</td>
      <td>${pct(b.mastery)}</td>
      <td>${pct(b.mastery_assisted)}</td>
      <td>${pct(b.priority)}</td>
      <td>${b.needs_review ? '⛔ 事实冲突' : b.low_sample ? '样本&lt;5' : ''}</td>
    </tr>`).join('')}
    </tbody></table>
  `;
  function pct(v) { return v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`; }
}

let practice = null;

async function pagePractice() {
  view.innerHTML = `
    <h1>练习</h1>
    <p class="muted">训练顺序：读完整答案 → 只看锚点 → 盲测 → 按漏点再练。盲测在你点「揭示」前不显示任何块内容；揭示行为会记入事件（该次不进独立掌握度）。</p>
    <div id="pr-start">
      <select id="pr-mode">
        <option value="mock_blind">盲测（mock_blind）</option>
        <option value="mock_anchor">锚点（mock_anchor）</option>
        <option value="mock_assisted">完整提词（mock_assisted）</option>
        <option value="real_record_only">真实面试·仅记录（不显示提示）</option>
      </select>
      <button id="pr-begin">开始练习</button>
      <button id="pr-voice">🎙 开始语音采集（实验）</button>
      <p class="muted" id="pr-voice-note">语音模式：麦克风采集（AudioWorklet 16k PCM）→ 实时转写 → 按上方模式提词。当前 ASR provider 未配置时仅 mock 演练；云端 Key 验收见文档。</p>
    </div>
    <div id="pr-area"></div>
  `;
  view.querySelector('#pr-begin').addEventListener('click', async () => {
    const mode = view.querySelector('#pr-mode').value;
    practice = await api('/api/practice/start', { method: 'POST', body: { mode } });
    renderPracticeInput(`已开始：${practice.mode}`);
  });
  view.querySelector('#pr-voice').addEventListener('click', () => {
    // 云连接披露闸门（spec §9.1/§10）：音频将发往配置的 ASR 服务，按量计费
    const confirmed = confirm(
      '🎙 即将开始麦克风采集。\n\n' +
      '数据去向：音频仅发送到本机 server（127.0.0.1），再由 server 转发到你配置的 ASR 服务（当前默认 mock，本地演练不外发）。\n' +
      '费用：云端 ASR 按量计费（百炼 fun-asr-realtime 约 1.188 元/小时），本场默认预算 3 元。\n\n' +
      '确认开始？'
    );
    if (confirmed) startVoicePractice();
  });

  function renderPracticeInput(msg) {
    view.querySelector('#pr-area').innerHTML = `
      <p class="muted">${esc(msg)}</p>
      <form id="q-form"><input id="q-text" placeholder="（模拟）面试官的问题…" autocomplete="off"><button>定位</button></form>
      <div id="q-result"></div>
      <div id="q-actions"></div>
      <button id="pr-finish">结束练习</button>
    `;
    view.querySelector('#q-form').addEventListener('submit', onQuestion);
    view.querySelector('#pr-finish').addEventListener('click', async () => {
      await api(`/api/practice/${practice.session_id}/finish`, { method: 'POST' });
      view.querySelector('#pr-area').innerHTML = '<p>练习已结束（事件已落盘）。</p>';
    });
  }

  async function onQuestion(e) {
    e.preventDefault();
    const text = view.querySelector('#q-text').value;
    const r = await api(`/api/practice/${practice.session_id}/question`, { method: 'POST', body: { text } });
    const resultBox = view.querySelector('#q-result');
    const actions = view.querySelector('#q-actions');
    if (r.record_only) {
      resultBox.innerHTML = '<p class="muted">真实记录模式：不显示定位（只记录）。</p>';
      return;
    }
    if (r.blind) {
      resultBox.innerHTML = '<p>🙈 盲测中——先口头作答，答完再揭示。</p>';
      actions.innerHTML = '<button id="reveal-btn">揭示答案</button>';
      actions.querySelector('#reveal-btn').addEventListener('click', () => doReveal(r.question_ref));
      return;
    }
    if (r.decision === 'hit') {
      const b = r.block;
      if (b.body !== undefined) {
        resultBox.innerHTML = `<p>✅ 命中 <b>${esc(b.block_id)}</b></p><div class="md-body">${mdRender(b.body)}</div>`;
        actions.innerHTML = ratingHtml(r.question_ref, false);
        wireRating();
      } else {
        resultBox.innerHTML = `<p>⚓ 锚点模式 <b>${esc(b.block_id)}</b>：${(b.anchors || []).map((a) => esc('#' + a)).join(' ')}</p>`;
        actions.innerHTML = ratingHtml(r.question_ref, false);
        wireRating();
      }
      return;
    }
    if (r.decision === 'candidates') {
      resultBox.innerHTML = `<p>❓ 多候选（手动锁定）：${r.candidates.map((c) => esc(c.blockId)).join('、')}</p>`;
      actions.innerHTML = ratingHtml(r.question_ref, false);
      wireRating();
      return;
    }
    resultBox.innerHTML = '<p>🚫 未知问题——这是知识缺口，回 CLI 记种子。</p>';
  }

  function ratingHtml(ref, revealed) {
    return `<div class="rating" data-ref="${esc(ref)}" data-revealed="${revealed}">自评：${[0, 1, 2, 3, 4].map((s) => `<button data-score="${s}">${s}</button>`).join(' ')}</div>`;
  }
  function wireRating() {
    view.querySelectorAll('.rating button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const box = btn.closest('.rating');
        await api(`/api/practice/${practice.session_id}/rate`, {
          method: 'POST',
          body: { question_ref: box.dataset.ref, score: Number(btn.dataset.score), revealed: box.dataset.revealed === 'true' },
        });
        box.innerHTML = '<span class="muted">已记录自评</span>';
      });
    });
  }
  async function doReveal(ref) {
    const r = await api(`/api/practice/${practice.session_id}/reveal`, { method: 'POST', body: { question_ref: ref } });
    const resultBox = view.querySelector('#q-result');
    resultBox.innerHTML = `<p>👁 已揭示（该次不进独立掌握度）：${r.block ? `<b>${esc(r.block.block_id)}</b>` : '无命中'}</p><div class="md-body">${r.block ? mdRender(r.block.body) : esc((r.candidates || []).join('、') || '（无候选）')}</div>`;
    view.querySelector('#q-actions').innerHTML = ratingHtml(ref, true);
    wireRating();
  }
}

async function pageReplay() {
  const { sessions } = await api('/api/sessions');
  view.innerHTML = `
    <h1>Replay</h1>
    ${sessions.length ? sessions.map((s) => `
      <details><summary>${esc(s.session_id.slice(0, 8))}… ${esc(s.mode)} ${s.round ? '· ' + esc(s.round) : ''} ${s.retrospective ? '· 历史' : ''}</summary>
        <div class="replay-body" data-sid="${esc(s.session_id)}"><p class="muted">加载中…</p></div>
      </details>`).join('') : '<p class="muted">还没有 session。真实面试走 CLI import，模拟练习走练习页。</p>'}
  `;
  for (const s of sessions) {
    api(`/api/sessions/${s.session_id}`).then((d) => {
      const el = view.querySelector(`.replay-body[data-sid="${s.session_id}"]`);
      if (!el) return;
      const qs = d.questions || [];
      const rv = d.review;
      const rvRows = Array.isArray(rv) ? rv : (rv?.questions || []);
      const finals = (d.events || []).filter((e) => e.type === 'asr.final');
      el.innerHTML = `
        <p class="muted">utterances ${d.utterances.length} · 问题 ${qs.length} · ${rvRows.length ? '已复盘' : '未复盘'}</p>
        ${finals.length ? `<h3>转写记录（asr.final ${finals.length} 句）</h3>
          <div class="md-body">${finals.map((e) => `<p>🟢 ${esc(e.payload?.text || '')}</p>`).join('')}</div>` : ''}
        ${rvRows.length ? `<h3>复盘摘要</h3>
          <table><thead><tr><th>问题</th><th>块</th><th>五维分</th><th>冲突</th></tr></thead><tbody>
          ${rvRows.map((r) => `<tr>
            <td>${esc((qs.find((q) => q.question_id === r.question_id)?.text || r.question_id).slice(0, 40))}</td>
            <td>${esc(r.block_id || '—')}</td>
            <td>${esc(Object.entries(r.dimensions || {}).map(([k, v]) => `${k[0].toUpperCase()}${v.score}`).join(' '))}</td>
            <td>${(r.fact_conflicts || []).length ? '⛔' : ''}</td>
          </tr>`).join('')}
        </tbody></table>` : ''}
        <h3>问题对齐（人工确认）</h3>
        ${qs.length ? `<table><thead><tr><th>问题</th><th>状态</th><th>块</th><th>确认</th></tr></thead><tbody>
          ${qs.map((q) => `<tr>
            <td>${esc(q.text.slice(0, 60))}</td>
            <td>${esc(q.alignment?.status || '—')}</td>
            <td>${esc((q.alignment?.matched_block_ids || []).join(','))}</td>
            <td><button class="confirm-align" data-qid="${esc(q.question_id)}">确认当前对齐</button></td>
          </tr>`).join('')}
        </tbody></table>` : '<p class="muted">尚未切分（先走 CLI segment）。</p>'}
        <h3>说话人纠正</h3>
        ${d.utterances.slice(0, 20).map((u) => `<div class="utt">
          <select class="role-fix" data-uid="${esc(u.id)}">
            ${['interviewer', 'candidate', 'unknown'].map((role) => `<option ${u.role === role ? 'selected' : ''}>${role}</option>`).join('')}
          </select>
          <span>${esc(u.raw_text.slice(0, 90))}</span>
        </div>`).join('')}
        <p class="muted">仅显示前 20 条；完整纠正走 CLI。</p>
      `;
      el.querySelectorAll('.confirm-align').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const q = qs.find((x) => x.question_id === btn.dataset.qid);
          await api(`/api/sessions/${s.session_id}/confirm-alignment`, {
            method: 'POST',
            body: { question_id: q.question_id, status: q.alignment?.status || 'unmatched', matched_block_ids: q.alignment?.matched_block_ids || [] },
          });
          btn.textContent = '✓ 已确认';
        });
      });
      el.querySelectorAll('.role-fix').forEach((sel) => {
        sel.addEventListener('change', async () => {
          await api(`/api/sessions/${s.session_id}/correct`, { method: 'POST', body: { utterance_id: sel.dataset.uid, role: sel.value } });
          sel.classList.add('saved');
        });
      });
    }).catch(() => {});
  }
}

async function pageSettings() {
  let statsOk = false;
  try { await api('/api/stats'); statsOk = true; } catch {}
  view.innerHTML = `
    <h1>设置</h1>
    <p>API 连通性：${statsOk ? '✅ 正常' : '✗ 异常'}</p>
    <h2>Provider</h2>
    <p class="muted">默认 lexical 检索，无需任何 Key。BYOK embedding（如百炼 text-embedding-v4）通过环境变量提供 Key——<b>Key 永不回显、不写日志</b>；本页只显示是否配置了对应的 env 名称。</p>
    <h2>安全模型</h2>
    <ul>
      <li>服务只监听 127.0.0.1；token 在启动时打印于终端</li>
      <li>所有数据本地读写（interview-prep/），不上传</li>
      <li>转录等非可信内容渲染时已 HTML-escape</li>
    </ul>
    <h2>删除数据</h2>
    <p class="muted">整目录删除 <code>interview-prep/</code> 即可（派生 cache 可重建）。</p>
  `;
}

const routes = {
  '/kb': pageKb,
  '/packs': pagePacks,
  '/heatmap': pageHeatmap,
  '/practice': pagePractice,
  '/replay': pageReplay,
  '/settings': pageSettings,
};

async function route() {
  const hash = location.hash.replace('#', '') || '/kb';
  const page = routes[hash] || pageKb;
  view.innerHTML = '<p class="muted">加载中…</p>';
  try {
    await page();
  } catch (e) {
    view.innerHTML = `<p>✗ ${esc(e.message)}</p>`;
  }
}

window.addEventListener('hashchange', route);
route();


// ---------- 语音采集（spec §9.1）----------
let voiceState = null; // {ws, audioCtx, stream, workletNode, captureState}

async function startVoicePractice() {
  const mode = view.querySelector('#pr-mode').value;
  const area = view.querySelector('#pr-area');
  area.innerHTML = '<p class="muted">请求麦克风权限…</p>';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
  } catch (e) {
    area.innerHTML = `<p>✗ 麦克风权限被拒绝：${esc(e.message)}</p>`;
    return;
  }
  const audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') await audioCtx.resume(); // 无 resume 则 worklet 永不运行 → 无转写
  await audioCtx.audioWorklet.addModule('worklet.js');
  const src = audioCtx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioCtx, 'pcm-16k');
  // AudioWorkletNode 必须连 destination 才会被拉动；零增益防止采集音回放形成回声回路
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(audioCtx.destination);
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${wsProto}//${location.host}/ws/capture?token=${encodeURIComponent(sessionStorage.getItem(TOKEN_KEY) || '')}`);
  voiceState = { ws, audioCtx, stream, node, state: 'permission_pending' };
  area.innerHTML = `
    <p id="vc-state">状态：<b>connecting</b></p>
    <p id="vc-live" class="muted">（实时转写预览）</p>
    <div id="vc-hint"></div>
    <button id="vc-lock">🔒 锁定当前定位</button>
    <button id="vc-stop">⏹ 停止采集</button>
  `;
  const setState = (s, extra = '') => {
    if (voiceState) voiceState.state = s;
    const el = view.querySelector('#vc-state');
    if (el) el.innerHTML = `状态：<b>${esc(s)}</b>${extra}`;
  };
  ws.addEventListener('open', () => {
    setState('connecting');
    ws.send(JSON.stringify({ type: 'start', mode }));
    src.connect(node);
  });
  node.port.onmessage = (e) => {
    if (e.data?.type === 'pcm' && ws.readyState === WebSocket.OPEN && voiceState?.state === 'recording') {
      // worklet 传的是 ArrayBuffer（worklet 作用域无 btoa）；主线程编码 base64
      const bytes = new Uint8Array(e.data.data);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      ws.send(JSON.stringify({ type: 'pcm', data: btoa(binary) }));
    }
  };
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'state') {
      if (m.state) setState(m.state);
      if (m.locked !== undefined) setState(voiceState?.state || 'recording', m.locked ? ' · 🔒 已锁定' : '');
    }
    if (m.type === 'asr' && m.event?.text) {
      const live = view.querySelector('#vc-live');
      if (live) live.textContent = `${m.event.type === 'final' ? '🟢' : '⏳'} ${m.event.text}`;
    }
    if (m.type === 'hint') renderVoiceHint(m);
    if (m.type === 'error') {
      const live = view.querySelector('#vc-live');
      if (live) live.textContent = `✗ ${esc(m.message)}`;
    }
  });
  view.querySelector('#vc-lock').addEventListener('click', () => {
    try { ws.send(JSON.stringify({ type: 'lock', locked: true })); } catch { setState('error', ' · 连接已断开'); }
  });
  view.querySelector('#vc-stop').addEventListener('click', () => {
    try { ws.send(JSON.stringify({ type: 'stop' })); } catch { /* 已断开也要走本地收尾 */ }
    setState('finished');
    stopVoice();
  });

  function renderVoiceHint(hint) {
    const box = view.querySelector('#vc-hint');
    if (!box) return;
    if (hint.blind) {
      box.innerHTML = '<p>🙈 盲测中——口头作答后点「揭示」。</p>';
      return;
    }
    if (hint.decision === 'hit' && hint.block) {
      box.innerHTML = `<p>✅ 命中 <b>${esc(hint.block.block_id)}</b></p><div class="md-body">${mdRender(hint.block.body)}</div>`;
    } else if (hint.decision === 'candidates') {
      box.innerHTML = `<p>❓ 候选：${(hint.candidates || []).map((c) => esc(c.blockId)).join('、')}</p>`;
    } else {
      box.innerHTML = '<p class="muted">未命中（知识缺口）</p>';
    }
  }
}

function stopVoice() {
  if (!voiceState) return;
  try { voiceState.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { voiceState.audioCtx.close(); } catch {}
  try { voiceState.ws.close(); } catch {}
  voiceState = null;
}
window.addEventListener('beforeunload', stopVoice);
