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
          <div class="meta">${s.windows} 窗口 · ${rel(s.created)}创建</div>
          ${pv ? `<pre class="preview">${pv}</pre>` : ''}
        </div>
        <button class="btn primary">打开</button>
        <button class="btn danger">✕</button>`);
      if (s.state === 'waiting') el.classList.add('attention');
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

function setMode(mode) {
  state.mode = mode;
  const direct = mode === 'direct';
  $('#quickbar').classList.toggle('hidden', !direct);
  $('#inputbar').classList.toggle('hidden', direct);
  if (state.term) {
    state.term.options.disableStdin = !direct;
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

  term.onData((d) => {
    if (state.mode !== 'direct') return;
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

/* ---------- 触屏滑动 → 合成滚轮事件 ----------
   iOS 上 xterm.js 不把触摸翻译成滚动;把手指位移合成 WheelEvent 喂给它,
   后面 xterm→tmux(mouse on)的整套滚动逻辑全部复用。 */
(() => {
  const wrap = $('#term-wrap');
  let lastY = null;
  let acc = 0;
  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      lastY = e.touches[0].clientY;
      acc = 0;
    }
  }, { passive: true });
  wrap.addEventListener('touchmove', (e) => {
    if (lastY === null || e.touches.length !== 1 || !state.term) return;
    const t = e.touches[0];
    acc += (lastY - t.clientY) * 3;
    lastY = t.clientY;
    // xterm 丢弃两类滚轮:无坐标的(算不出行列报文)、折算不足一行的。
    // 所以:带真实触点坐标 + 位移攒够 ~一行字高才派发,派发到手指所在元素走原生冒泡路径。
    if (Math.abs(acc) < 24) return;
    e.target.dispatchEvent(new WheelEvent('wheel', {
      deltaY: acc,
      deltaMode: 0,
      bubbles: true,
      cancelable: true,
      clientX: t.clientX,
      clientY: t.clientY,
    }));
    acc = 0;
  }, { passive: true });
  wrap.addEventListener('touchend', () => { lastY = null; acc = 0; }, { passive: true });
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
      toast('回滚模式:滑动翻页,Esc 退出');
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
