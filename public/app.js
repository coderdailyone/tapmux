/* tapmux 前端:会话列表 + 终端(直敲/输入条双模式) */
'use strict';

const $ = (s) => document.querySelector(s);

// 基准路径:直连时为 "/",经 relay 挂载时为 "/d/<设备>/"。所有请求都从这里出发
const BASE = location.pathname.endsWith('/')
  ? location.pathname
  : location.pathname.replace(/[^/]*$/, '');
const u = (p) => BASE + String(p).replace(/^\//, '');

// 经 relay 挂载时,列表页给一个回门户的按钮(脚本在 body 尾部,DOM 已就绪)
if (BASE.startsWith('/d/')) {
  document.querySelector('#portal-back')?.classList.remove('hidden');
}

const state = {
  cur: null,          // 当前打开的会话名
  term: null,
  fit: null,
  ws: null,
  closing: false,     // 主动关闭时禁止重连
  everConnected: false,
  retryMs: 500,
  retryTimer: null,
  mode: 'compose',    // compose=输入条 direct=直敲
  ctrlSticky: false,
  fontSize: 14,
  wakeLock: null,
  wantWake: false,
};

/* ---------- 基础 ---------- */

async function api(path, opts = {}) {
  const res = await fetch(u(path), {
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 260);
  }, 2100);
}

/* ---------- 底部动作板 ---------- */
function openSheet(html) {
  $('#sheet').innerHTML = html;
  requestAnimationFrame(() => { $('#scrim').classList.add('show'); $('#sheet').classList.add('show'); });
}
function closeSheet() {
  $('#scrim').classList.remove('show');
  $('#sheet').classList.remove('show');
}
$('#scrim').onclick = closeSheet;
window.closeSheet = closeSheet;

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- 会话宏 ---------- */
const trigSummary = (m) => {
  const t = m.trigger || {};
  if (t.type === 'interval') return `每 ${t.everySec}s → ${m.action.text}`;
  return `${t.type === 'missing' ? '缺失' : '出现'} "${t.pattern}" → ${m.action.text}`;
};

async function saveMacros(name, macros) {
  await api(`/api/sessions/${encodeURIComponent(name)}/macros`, { method: 'PUT', body: { macros } });
}

function macroPanel(s) {
  const rows = (s.macros || []).map((m, i) => `
    <div class="macro-row">
      <input type="checkbox" data-t="${i}" ${m.enabled !== false ? 'checked' : ''}>
      <span class="m-main">
        <span class="m-name">${escapeHtml(m.name)}</span>
        <span class="m-sub">${escapeHtml(trigSummary(m))}</span>
      </span>
      <button class="del" data-d="${i}">删除</button>
    </div>`).join('') || '<p class="note">还没有宏。宏在会话空闲且无人打字时才会注入,自带冷却。</p>';
  openSheet(`<div class="pane"><div class="body">
    <h3>宏 · ${escapeHtml(s.name)}</h3>
    ${rows}
    <button class="wide-btn" id="mk-pin">＋ 钉住模型(预设)</button>
    <button class="wide-btn ghost" id="mk-custom">＋ 自定义宏</button>
    <button class="wide-btn ghost" onclick="closeSheet()">完成</button>
  </div></div>`);

  const mut = async (fn) => {
    const next = JSON.parse(JSON.stringify(s.macros || []));
    fn(next);
    try { await saveMacros(s.name, next); s.macros = next; macroPanel(s); }
    catch (e) { toast(e.message); }
  };
  $('#sheet').querySelectorAll('[data-t]').forEach((el) => {
    el.onchange = () => mut((list) => { list[Number(el.dataset.t)].enabled = el.checked; });
  });
  $('#sheet').querySelectorAll('[data-d]').forEach((el) => {
    el.onclick = () => mut((list) => { list.splice(Number(el.dataset.d), 1); });
  });
  $('#mk-pin').onclick = () => macroForm(s, {
    name: '钉住模型', type: 'missing', pattern: '\\[Fable 5\\.1\\]',
    text: '/model claude-fable-5-1', confirmEnter: false, cooldownSec: 300,
    note: '状态条上找不到「[Fable 5.1]」(=被降级)且会话空闲时,自动切回 Fable 5.1。tapmux 发 /model 走选择器、只改本会话,不动全机默认模型。字样按你状态条实际显示改。',
  });
  $('#mk-custom').onclick = () => macroForm(s, {
    name: '', type: 'missing', pattern: '', text: '', confirmEnter: false, cooldownSec: 300,
    note: '触发类型:字样缺失/字样出现(正则,按屏幕内容匹配)或定时。',
  });
}

function macroForm(s, d) {
  openSheet(`<div class="pane"><div class="body">
    <h3>${d.name ? escapeHtml(d.name) : '自定义宏'}</h3>
    <p class="note">${escapeHtml(d.note)}</p>
    <label class="f">名称</label><input type="text" id="mf-name" value="${escapeHtml(d.name)}">
    <label class="f">触发类型</label>
    <select id="mf-type">
      <option value="missing" ${d.type === 'missing' ? 'selected' : ''}>屏幕缺失字样时</option>
      <option value="present" ${d.type === 'present' ? 'selected' : ''}>屏幕出现字样时</option>
      <option value="interval" ${d.type === 'interval' ? 'selected' : ''}>定时</option>
    </select>
    <label class="f" id="mf-pat-l">匹配字样(正则)</label><input type="text" id="mf-pattern" value="${escapeHtml(d.pattern)}">
    <label class="f" id="mf-int-l" style="display:none">间隔(秒,≥60)</label><input type="number" id="mf-every" value="300" style="display:none">
    <label class="f">注入指令</label><input type="text" id="mf-text" value="${escapeHtml(d.text)}">
    <label class="f" style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--fg)">
      <input type="checkbox" id="mf-confirm" ${d.confirmEnter ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--accent)"> 若弹出确认框,自动补回车
    </label>
    <label class="f">冷却(秒,≥60)</label><input type="number" id="mf-cd" value="${d.cooldownSec}">
    <button class="wide-btn" id="mf-save">保存</button>
    <button class="wide-btn ghost" onclick="closeSheet()">取消</button>
  </div></div>`);
  const sync = () => {
    const iv = $('#mf-type').value === 'interval';
    $('#mf-pat-l').style.display = $('#mf-pattern').style.display = iv ? 'none' : '';
    $('#mf-int-l').style.display = $('#mf-every').style.display = iv ? '' : 'none';
  };
  $('#mf-type').onchange = sync;
  sync();
  $('#mf-save').onclick = async () => {
    const type = $('#mf-type').value;
    const macro = {
      id: Math.random().toString(36).slice(2, 10),
      name: $('#mf-name').value.trim(),
      enabled: true,
      trigger: type === 'interval'
        ? { type, everySec: Number($('#mf-every').value) }
        : { type, pattern: $('#mf-pattern').value },
      action: { text: $('#mf-text').value, enter: true, confirmEnter: $('#mf-confirm').checked },
      cooldownSec: Number($('#mf-cd').value) || 300,
    };
    const next = [...(s.macros || []), macro];
    try { await saveMacros(s.name, next); s.macros = next; toast('宏已保存'); macroPanel(s); }
    catch (e) { toast(e.message); }
  };
}

function rel(ts) {
  const s = Math.max(1, (Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/* ---------- 视口(iOS 键盘) ---------- */

let vhFitTimer = null;
let appliedVH = 0;
function updateVH() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  appliedVH = h;
  document.documentElement.style.setProperty('--vh', `${h}px`);
  window.scrollTo(0, 0);
  // 键盘弹收动画期间事件连发,防抖到安定后只重排一次(否则 iOS 卡爆)
  if (state.fit && state.cur) {
    clearTimeout(vhFitTimer);
    vhFitTimer = setTimeout(() => {
      if (state.fit && state.cur) {
        state.fit.fit();
        sendResize();
      }
    }, 180);
  }
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateVH);
  window.visualViewport.addEventListener('scroll', () => window.scrollTo(0, 0));
}
window.addEventListener('resize', updateVH);
// iOS 键盘收起时视口事件经常被吞:焦点变化多点补测 + 700ms 看门狗兜底,卡住状态自愈
document.addEventListener('focusout', () => { [60, 300, 700].forEach((t) => setTimeout(updateVH, t)); });
document.addEventListener('focusin', () => { setTimeout(updateVH, 300); });
setInterval(() => {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  if (Math.abs(h - appliedVH) > 2) updateVH();
}, 700);

/* ---------- 会话列表 ---------- */

function card(html) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = html;
  return el;
}

function badges(s) {
  let b = '';
  if ((s.cmds || []).includes('claude')) b += '<span class="badge claude">claude</span>';
  if (s.state === 'waiting') b += '<span class="badge st-waiting">● 等你确认</span>';
  else if (s.state === 'working') b += '<span class="badge st-working">● 干活中</span>';
  else if (s.state === 'idle') b += '<span class="badge st-idle">● 空闲</span>';
  if (s.attached > 0) b += `<span class="badge">👀 ${s.attached}</span>`;
  return b;
}

async function loadList() {
  const status = $('#list-status');
  try {
    const { managed, wild, dead } = await api('/api/sessions');
    status.classList.add('hidden');

    const secM = $('#sec-managed'); const cm = $('#cards-managed'); cm.innerHTML = '';
    secM.classList.toggle('hidden', managed.length === 0);
    for (const s of managed) {
      const pv = (s.preview || []).map((l) => l.replace(/</g, '&lt;')).join('\n');
      const el = card(`
        <div class="info">
          <div class="name">${s.name} ${badges(s)}</div>
          <div class="meta">${s.windows} 窗口 · ${rel(s.created)}创建${s.model ? ` · ${escapeHtml(s.model)}` : ''}</div>
          ${pv ? `<pre class="preview">${pv}</pre>` : ''}
        </div>
        <button class="btn mini${(s.macros || []).length ? ' has' : ''}">宏${(s.macros || []).length ? '·' + s.macros.length : ''}</button>
        <button class="btn primary">打开</button>
        <button class="btn danger">✕</button>`);
      if (s.state === 'waiting') el.classList.add('attention');
      el.querySelector('.btn.mini').onclick = () => macroPanel(s);
      el.querySelector('.btn.primary').onclick = () => { location.hash = `#/t/${encodeURIComponent(s.name)}`; };
      el.querySelector('.btn.danger').onclick = async () => {
        if (!window.confirm(`关闭会话 ${s.name}?里面正在跑的程序会被结束。`)) return;
        try { await api(`/api/sessions/${encodeURIComponent(s.name)}`, { method: 'DELETE' }); loadList(); }
        catch (e) { toast(e.message); }
      };
      cm.appendChild(el);
    }

    const secW = $('#sec-wild'); const cw = $('#cards-wild'); cw.innerHTML = '';
    secW.classList.toggle('hidden', wild.length === 0);
    for (const s of wild) {
      const el = card(`
        <div class="info">
          <div class="name">${s.name} ${badges(s)}</div>
          <div class="meta">${s.windows} 窗口 · ${rel(s.created)}创建 · 未纳管</div>
        </div>
        <button class="btn">纳管</button>`);
      el.querySelector('.btn').onclick = async () => {
        try { await api(`/api/sessions/${encodeURIComponent(s.name)}/adopt`, { method: 'POST' }); loadList(); }
        catch (e) { toast(e.message); }
      };
      cw.appendChild(el);
    }

    const secD = $('#sec-dead'); const cd = $('#cards-dead'); cd.innerHTML = '';
    secD.classList.toggle('hidden', dead.length === 0);
    for (const name of dead) {
      const el = card(`
        <div class="info"><div class="name">${name}</div><div class="meta">tmux 里已不存在</div></div>
        <button class="btn">移除</button>`);
      el.querySelector('.btn').onclick = async () => {
        await api(`/api/managed/${encodeURIComponent(name)}`, { method: 'DELETE' });
        loadList();
      };
      cd.appendChild(el);
    }
  } catch (e) {
    status.classList.remove('hidden');
    status.textContent = `加载失败:${e.message}`;
  }
}

$('#btn-refresh').onclick = loadList;
$('#btn-new').onclick = () => $('#new-panel').classList.toggle('hidden');
$('#new-cancel').onclick = () => $('#new-panel').classList.add('hidden');
$('#new-create').onclick = async () => {
  const name = $('#new-name').value.trim();
  if (!name) { toast('起个名字'); return; }
  try {
    await api('/api/sessions', { method: 'POST', body: { name, claude: $('#new-claude').checked } });
    $('#new-panel').classList.add('hidden');
    $('#new-name').value = '';
    location.hash = `#/t/${encodeURIComponent(name)}`;
  } catch (e) { toast(e.message); }
};

/* ---------- 终端 ---------- */

function dot(cls) { $('#conn-dot').className = `dot ${cls}`; }

function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

function sendResize() {
  if (!state.term) return;
  const { cols, rows } = state.term;
  if (cols === state.sentCols && rows === state.sentRows) return; // 尺寸没变不惊动 tmux
  state.sentCols = cols;
  state.sentRows = rows;
  wsSend({ t: 'resize', cols, rows });
}

function connect() {
  if (state.closing || !state.cur) return;
  // 防重连风暴:已有活连接(含握手中)绝不再开新的
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(state.retryTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = `session=${encodeURIComponent(state.cur)}&cols=${state.term.cols}&rows=${state.term.rows}`;
  const ws = new WebSocket(`${proto}://${location.host}${u('ws/attach')}?${q}`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;
  dot('mid');

  ws.onopen = () => {
    if (state.ws !== ws) { ws.close(); return; } // 过期连接直接丢弃
    dot('on');
    state.retryMs = 500;
    if (state.everConnected) state.term.reset(); // 重连:清屏等 tmux 权威重绘
    state.everConnected = true;
    state.sentCols = null; // 断线期间尺寸可能变了,强制同步一次
    sendResize();
  };
  ws.onmessage = (ev) => {
    if (state.ws !== ws) return;
    if (typeof ev.data === 'string') return; // 控制帧,暂无需处理
    state.term.write(new Uint8Array(ev.data));
  };
  ws.onclose = () => {
    if (state.ws !== ws || state.closing) return; // 只有"当前连接"的关闭才触发重连
    dot('off');
    clearTimeout(state.retryTimer);
    state.retryTimer = setTimeout(connect, state.retryMs);
    state.retryMs = Math.min(state.retryMs * 1.6, 5000);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// xterm 在应用开了鼠标模式时把滚轮翻译成 SGR 报文(ESC[<b;x;yM),焦点事件是 ESC[I / ESC[O
const isTerminalReport = (d) => /^(\x1b\[(<\d+;\d+;\d+[Mm]|[IO]))+$/.test(d);

// 应用是否自己接管了鼠标(Claude Code 2.1+ 回复在应用内虚拟滚动,不进 tmux 历史)
function appHasMouse() {
  try { return Boolean(state.term) && state.term.modes.mouseTrackingMode !== 'none'; }
  catch { return false; }
}

// 不接管鼠标的应用:滚动按行数交给服务端(rows 正 = 往回翻),由它按应用决定怎么翻——
// codex 发 PgUp/PgDn 翻它自己的记录,其余走 tmux copy-mode 翻 pane 历史。
// 同一时刻只飞一个请求,其间累积的行数并进下一发,快速滑动也不会打出请求风暴
const serverScroll = (() => {
  let pending = 0;
  let busy = false;
  const flush = async () => {
    if (busy || !pending || !state.cur) return;
    const n = Math.max(-50, Math.min(50, pending));
    pending -= n;
    busy = true;
    try {
      await api(`/api/sessions/${encodeURIComponent(state.cur)}/send`, {
        method: 'POST', body: { scroll: n > 0 ? 'up' : 'down', lines: Math.abs(n) },
      });
    } catch {} finally {
      busy = false;
      flush();
    }
  };
  return (rows) => { pending += rows; flush(); };
})();

function setMode(mode) {
  state.mode = mode;
  const direct = mode === 'direct';
  $('#quickbar').classList.toggle('hidden', !direct);
  $('#inputbar').classList.toggle('hidden', direct);
  if (state.term) {
    // 不用 disableStdin:它会连鼠标滚轮报文一起掐掉,输入条模式就没法滑动翻 Claude Code 的回复。
    // 键盘输入的过滤在 onData 里按模式做。
    if (direct) state.term.focus();
    else state.term.blur();
  }
  requestAnimationFrame(updateVH);
}

function setCtrl(on) {
  state.ctrlSticky = on;
  $('#qk-ctrl').classList.toggle('active', on);
}

function openTerm(name) {
  if (state.cur === name) return;
  if (state.cur) teardownTerm();

  state.cur = name;
  state.closing = false;
  state.everConnected = false;
  $('#term-title').textContent = name;
  $('#view-list').classList.add('hidden');
  $('#view-term').classList.remove('hidden');

  const term = new Terminal({
    fontSize: state.fontSize,
    fontFamily: "ui-monospace, Menlo, 'SF Mono', Consolas, monospace",
    cursorBlink: true,
    scrollback: 2000,
    theme: {
      background: '#0a0e13',
      foreground: '#e8eef5',
      cursor: '#34d399',
      selectionBackground: 'rgba(52,211,153,.3)',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#term'));
  state.term = term;
  state.fit = fit;

  // 桌面滚轮/触控板同理:不接管鼠标的应用,滚轮折成行数交给服务端翻(见触屏滑动处的说明)
  let wheelRows = 0;
  term.attachCustomWheelEventHandler((ev) => {
    if (appHasMouse()) return true;
    const rowH = $('#term').getBoundingClientRect().height / Math.max(1, term.rows);
    const perRow = ev.deltaMode === 1 ? 1 : ev.deltaMode === 2 ? 1 / term.rows : rowH;
    wheelRows -= ev.deltaY / perRow; // 滚轮上推 deltaY<0 = 往回翻 = 正
    const rows = Math.trunc(wheelRows);
    if (rows) {
      wheelRows -= rows;
      serverScroll(rows);
    }
    ev.preventDefault();
    return false;
  });

  term.onData((d) => {
    // 输入条模式只放行鼠标/焦点报文(滚轮翻页靠它),键盘输入一律不发
    if (state.mode !== 'direct' && !isTerminalReport(d)) return;
    let data = d;
    if (state.ctrlSticky && d.length === 1) {
      const c = d.toUpperCase().charCodeAt(0);
      if (c >= 64 && c < 96) data = String.fromCharCode(c & 31);
      setCtrl(false);
    }
    wsSend({ t: 'input', data });
  });
  term.onResize(() => sendResize());

  updateVH();
  fit.fit();
  setMode('compose');
  connect();
}

function teardownTerm() {
  state.closing = true;
  clearTimeout(state.retryTimer);
  if (state.ws) { try { state.ws.close(); } catch {} }
  if (state.term) { state.term.dispose(); }
  $('#term').innerHTML = '';
  state.term = null; state.fit = null; state.ws = null; state.cur = null;
  setCtrl(false);
  dot('off');
}

$('#btn-back').onclick = () => { location.hash = '#/'; };

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // 锁屏回来:立刻重连 + 恢复防熄屏
  if (state.cur && (!state.ws || state.ws.readyState !== WebSocket.OPEN)) {
    clearTimeout(state.retryTimer);
    state.retryMs = 500;
    connect();
  }
  if (state.wantWake) acquireWake();
  if (!state.cur) loadList();
});

/* ---------- 触屏滑动 → 滚动 ----------
   按手指走过的行数滚(正 = 手指上推 = 往回翻,与侧栏 ▲ 同向):
   1) 应用接管了鼠标(Claude Code):直接发 SGR 滚轮报文,应用滚自己的虚拟视口;
   2) 否则(codex、shell…):行数交给服务端翻(codex 用 PgUp/PgDn 翻自己的记录,其余 tmux copy-mode)。
      不能把滚轮交给 xterm——tmux 让它处在备用屏、没有本地回滚,xterm 会把滚轮变成 ↑↓ 键,
      输入条模式下被丢掉,直敲模式下变成翻应用的输入历史(codex 里就是这样「翻不了页」)。 */
(() => {
  const wrap = $('#term-wrap');
  let lastY = null;
  let rowAcc = 0;
  const move = (e) => {
    if (lastY === null || e.touches.length !== 1 || !state.term) return;
    const t = e.touches[0];
    const rect = $('#term').getBoundingClientRect();
    const rowH = rect.height / Math.max(1, state.term.rows);
    rowAcc += lastY - t.clientY;
    lastY = t.clientY;
    const rows = Math.trunc(rowAcc / rowH);
    if (rows === 0) return;
    rowAcc -= rows * rowH;
    if (appHasMouse()) {
      // Claude Code 约两个报文滚一行,按行数翻倍发,手指走一行画面滚一行
      const col = Math.max(1, Math.min(state.term.cols, Math.ceil((t.clientX - rect.left) / (rect.width / state.term.cols))));
      const row = Math.max(1, Math.min(state.term.rows, Math.ceil((t.clientY - rect.top) / rowH)));
      const btn = rows > 0 ? 64 : 65;
      wsSend({ t: 'input', data: `\x1b[<${btn};${col};${row}M`.repeat(Math.abs(rows) * 2) });
      return;
    }
    serverScroll(rows);
  };
  // 触摸事件钉在按下时的元素上;xterm 一重绘就把行里的 span 换掉,换掉后事件不再冒泡到 wrap,
  // 滑到一半就断(从有字的地方起手最明显)。所以监听挂在起点元素自己身上,它离开文档也照样收得到
  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    lastY = e.touches[0].clientY;
    rowAcc = 0;
    const tgt = e.target;
    const end = () => {
      lastY = null;
      rowAcc = 0;
      tgt.removeEventListener('touchmove', move);
      tgt.removeEventListener('touchend', end);
      tgt.removeEventListener('touchcancel', end);
    };
    tgt.addEventListener('touchmove', move, { passive: true });
    tgt.addEventListener('touchend', end);
    tgt.addEventListener('touchcancel', end);
  }, { passive: true });
})();

/* ---------- 侧边滚轮:直接驱动 tmux 滚动,点按滚 5 行,按住连滚 ---------- */
(() => {
  for (const dir of ['up', 'down']) {
    const btn = $(`#rail-${dir}`);
    let timer = null;
    const fire = () => {
      if (!state.cur) return;
      api(`/api/sessions/${encodeURIComponent(state.cur)}/send`, { method: 'POST', body: { scroll: dir } })
        .catch(() => {});
    };
    const start = (e) => {
      e.preventDefault();
      fire();
      timer = setInterval(fire, 200);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    btn.addEventListener('touchstart', start, { passive: false });
    btn.addEventListener('touchend', stop);
    btn.addEventListener('touchcancel', stop);
    btn.addEventListener('mousedown', start);
    btn.addEventListener('mouseup', stop);
    btn.addEventListener('mouseleave', stop);
  }
})();

/* ---------- 快捷键条 ---------- */

$('#quickbar').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn || !state.cur) return;
  const key = btn.dataset.key;
  const act = btn.dataset.act;
  try {
    if (key) {
      await api(`/api/sessions/${encodeURIComponent(state.cur)}/send`, { method: 'POST', body: { keys: [key] } });
    } else if (act === 'mode') {
      setMode('compose');
    } else if (act === 'ctrl') {
      setCtrl(!state.ctrlSticky);
      state.term.focus();
    } else if (act === 'scroll') {
      await api(`/api/sessions/${encodeURIComponent(state.cur)}/send`, { method: 'POST', body: { copyMode: true } });
      toast(appHasMouse() ? '往上翻一页:继续滑动或用侧栏 ▲▼' : '回滚模式:滑动翻页,Esc 退出');
    } else if (act === 'font-' || act === 'font+') {
      state.fontSize = Math.min(22, Math.max(10, state.fontSize + (act === 'font+' ? 1 : -1)));
      state.term.options.fontSize = state.fontSize;
      state.fit.fit();
      sendResize();
    } else if (act === 'wake') {
      toggleWake();
    }
  } catch (e) { toast(e.message); }
});

/* ---------- 输入条 ---------- */

const compose = $('#compose');
compose.addEventListener('input', () => {
  compose.style.height = 'auto';
  compose.style.height = `${Math.min(compose.scrollHeight, 108)}px`;
});

document.querySelector('#inputbar [data-act=mode]').onclick = () => setMode('direct');

// 输入条模式的裸回车:Claude Code 的"按回车确认/继续"场景
$('#btn-enter').onclick = async () => {
  if (!state.cur) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(state.cur)}/send`, { method: 'POST', body: { keys: ['Enter'] } });
  } catch (e) { toast(e.message); }
};

$('#btn-send').onclick = async () => {
  const text = compose.value;
  if (!text.trim() || !state.cur) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(state.cur)}/send`, { method: 'POST', body: { text, enter: true } });
    compose.value = '';
    compose.style.height = 'auto';
    $('#chips').innerHTML = '';
    $('#chips').classList.add('hidden');
    compose.focus();
  } catch (e) { toast(e.message); }
};

/* ---------- 图片上传 ---------- */

$('#btn-photo').onclick = () => $('#file-input').click();

async function uploadOne(file) {
  const blob = await shrinkImage(file);
  const res = await fetch(u('api/upload'), {
    method: 'POST',
    headers: { 'content-type': blob.type },
    body: blob,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

  const chips = $('#chips');
  chips.classList.remove('hidden');
  const img = document.createElement('img');
  img.src = u(data.url);
  img.onclick = () => window.open(u(data.url));
  chips.appendChild(img);

  const sep = compose.value && !compose.value.endsWith(' ') ? ' ' : '';
  compose.value += `${sep}${data.path} `;
  compose.dispatchEvent(new Event('input'));
}

$('#file-input').addEventListener('change', async (ev) => {
  const files = [...(ev.target.files || [])];
  ev.target.value = '';
  if (!files.length) return;
  try {
    toast(files.length > 1 ? `上传 ${files.length} 张图片中…` : '处理图片中…');
    for (const f of files) await uploadOne(f);
    toast('已上传,路径已填入输入条');
  } catch (e) { toast(`上传失败:${e.message}`); }
});

// 客户端压图:长边 1600,jpeg 0.85;gif 原样(可能是动图)
async function shrinkImage(file) {
  if (file.type === 'image/gif') return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) throw new Error('图片编码失败');
  return blob;
}

/* ---------- 防熄屏 ---------- */

async function acquireWake() {
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    $('#qk-wake').classList.add('active');
    state.wakeLock.addEventListener('release', () => {
      state.wakeLock = null;
      $('#qk-wake').classList.remove('active');
    });
  } catch {
    state.wantWake = false;
    toast('防熄屏需要 HTTPS(接上公网域名后可用)');
  }
}

function toggleWake() {
  if (state.wakeLock) {
    state.wantWake = false;
    state.wakeLock.release();
  } else {
    state.wantWake = true;
    acquireWake();
  }
}

/* ---------- 路由 ---------- */

function route() {
  const m = location.hash.match(/^#\/t\/(.+)$/);
  if (m) {
    openTerm(decodeURIComponent(m[1]));
  } else {
    if (state.cur) teardownTerm();
    $('#view-term').classList.add('hidden');
    $('#view-list').classList.remove('hidden');
    loadList();
  }
}
window.addEventListener('hashchange', route);

// 列表页可见时定期轻刷新(探测本身是毫秒级本地命令,预览随之更新)
setInterval(() => {
  if (document.visibilityState === 'visible' && !state.cur) loadList();
}, 12000);

updateVH();
route();
