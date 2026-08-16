import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';

import { loadConfig, CONFIG_FILE } from './config.js';
import crypto from 'node:crypto';
import { checkAuth, originOk, clientIp, setInternalSecret, isInternal } from './auth.js';
import {
  listSessions, paneCommands, hasSession, createSession, killSession,
  sendText, validSessionName, validKeys, sendKeys, enterCopyMode, scrollPane,
  setAlternateScreenOff, capturePane,
} from './tmux.js';
import { ManagedStore } from './sessions.js';
import {
  saveImage, resolveServable, contentTypeFor, cleanupOldUploads, MAX_UPLOAD_BYTES,
} from './uploads.js';
import { handleAttach } from './attach.js';
import { previewFromCapture, detectClaudeState, contentFingerprint } from './preview.js';
import { Notifier } from './notify.js';
import { startAgent } from './agent.js';

const config = loadConfig();
const store = new ManagedStore(config.dataDir);

const pub = (f) => new URL(`../public/${f}`, import.meta.url).pathname;
// 经模块解析找 vendor 文件:npm 全局安装/被依赖安装时 node_modules 位置不定,不能猜相对路径
const require_ = createRequire(import.meta.url);
const vendor = (spec) => require_.resolve(spec);

// 显式静态文件表:不存在"按路径找文件",结构上无穿越可言
const STATIC = {
  '/': [pub('index.html'), 'text/html; charset=utf-8', 'no-cache'],
  '/app.js': [pub('app.js'), 'text/javascript; charset=utf-8', 'no-cache'],
  '/style.css': [pub('style.css'), 'text/css; charset=utf-8', 'no-cache'],
  '/manifest.webmanifest': [pub('manifest.webmanifest'), 'application/manifest+json', 'no-cache'],
  '/icon.svg': [pub('icon.svg'), 'image/svg+xml', 'public, max-age=86400'],
  '/apple-touch-icon.png': [pub('apple-touch-icon.png'), 'image/png', 'public, max-age=86400'],
  '/vendor/xterm.js': [vendor('@xterm/xterm/lib/xterm.js'), 'text/javascript', 'public, max-age=604800'],
  '/vendor/xterm.css': [vendor('@xterm/xterm/css/xterm.css'), 'text/css', 'public, max-age=604800'],
  '/vendor/addon-fit.js': [vendor('@xterm/addon-fit/lib/addon-fit.js'), 'text/javascript', 'public, max-age=604800'],
};

function send(res, code, body, headers = {}) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(code, { 'content-length': buf.length, ...headers });
  res.end(buf);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 256 * 1024) {
  const buf = await readBody(req, limit);
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('bad json'), { code: 'BAD_JSON' });
  }
}

// 一次 capture,同时产出预览与 Claude 状态
async function paneSnapshot(name, isClaude) {
  try {
    const text = await capturePane(name);
    return {
      preview: previewFromCapture(text),
      state: isClaude ? detectClaudeState(text) : null,
    };
  } catch {
    return { preview: [], state: null };
  }
}

// 探测:tmux 实况 × 纳管清单 → 三类(纳管在活/野会话/纳管已死)
async function probe() {
  const live = await listSessions();
  const cmds = await paneCommands();
  const liveNames = new Set(live.map((s) => s.name));
  const managed = [];
  const wild = [];
  for (const s of live) {
    const item = { ...s, cmds: cmds.get(s.name) || [], managed: store.has(s.name) };
    (item.managed ? managed : wild).push(item);
  }
  await Promise.all(managed.map(async (m) => {
    const snap = await paneSnapshot(m.name, m.cmds.includes('claude'));
    m.preview = snap.preview;
    m.state = snap.state;
  }));
  const dead = store.names().filter((n) => !liveNames.has(n));
  return { managed, wild, dead };
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    return sendJson(res, 200, await probe());
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    const body = await readJson(req);
    const name = body.name;
    if (!validSessionName(name)) return sendJson(res, 400, { error: '会话名只能用字母数字._-,50字以内' });
    if (await hasSession(name)) return sendJson(res, 409, { error: '同名会话已存在' });
    await createSession(name, { command: body.claude ? config.claudeCommand : undefined });
    store.add(name, 'created');
    return sendJson(res, 200, { ok: true, name });
  }

  // /api/sessions/:name/(adopt|send) 与 DELETE /api/sessions/:name
  if (parts[0] === 'api' && parts[1] === 'sessions' && parts.length >= 3) {
    const name = decodeURIComponent(parts[2]);
    if (!validSessionName(name)) return sendJson(res, 400, { error: 'bad name' });

    if (req.method === 'POST' && parts[3] === 'adopt') {
      if (!(await hasSession(name))) return sendJson(res, 404, { error: '会话不存在' });
      await setAlternateScreenOff(name); // 已锁死在备用屏的旧 pane 救不回,但保住后续启动的应用
      store.add(name, 'adopted');
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && parts[3] === 'send') {
      if (!store.has(name)) return sendJson(res, 403, { error: '未纳管的会话,先纳管' });
      if (!(await hasSession(name))) return sendJson(res, 404, { error: '会话不存在' });
      const body = await readJson(req);
      if (body.copyMode === true) {
        await enterCopyMode(name);
        return sendJson(res, 200, { ok: true });
      }
      if (body.scroll === 'up' || body.scroll === 'down') {
        await scrollPane(name, body.scroll);
        return sendJson(res, 200, { ok: true });
      }
      if (body.keys !== undefined) {
        if (!validKeys(body.keys)) return sendJson(res, 400, { error: '非法按键' });
        await sendKeys(name, body.keys);
        return sendJson(res, 200, { ok: true });
      }
      if (typeof body.text !== 'string' || body.text.length === 0) {
        return sendJson(res, 400, { error: 'text 必填' });
      }
      await sendText(name, body.text, { enter: body.enter !== false });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && parts.length === 3) {
      if (!store.has(name)) return sendJson(res, 403, { error: '未纳管的会话不能从网页关闭' });
      if (await hasSession(name)) await killSession(name);
      store.remove(name);
      return sendJson(res, 200, { ok: true });
    }
  }

  // 移除已死的纳管条目(不碰 tmux)
  if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'managed' && parts.length === 3) {
    store.remove(decodeURIComponent(parts[2]));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const buf = await readBody(req, MAX_UPLOAD_BYTES);
    const saved = saveImage(config.uploadDir, buf, req.headers['content-type']);
    return sendJson(res, 200, saved);
  }

  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  const auth = checkAuth(req, config.token);
  if (!auth.ok) {
    if (auth.blocked) return send(res, 429, '尝试过多,稍后再试');
    if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'unauthorized' });
    return send(res, 401, '<meta charset="utf-8">未授权:请用带 token 的完整链接打开', { 'content-type': 'text/html; charset=utf-8' });
  }
  if (auth.redirect) {
    // 相对跳转:经 relay 挂在子路径下时,浏览器会基于当前 URL 解析,直连时等价于 "/"
    return send(res, 302, '', { 'set-cookie': auth.setCookie, location: `.${auth.redirect || '/'}` });
  }

  // 隧道流量(带内部章)的 Origin 属于公网域名,与本机 Host 天然不同:
  // 跨站防护在 relay 层(用户 cookie SameSite + relay 端 Origin 校验)已完成,此处放行
  if (!isInternal(req) && req.method !== 'GET' && req.method !== 'HEAD' && !originOk(req)) {
    return sendJson(res, 403, { error: 'bad origin' });
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }

    if (url.pathname.startsWith('/uploads/')) {
      const abs = resolveServable(config.uploadDir, url.pathname);
      if (!abs) return send(res, 404, 'not found');
      return send(res, 200, fs.readFileSync(abs), {
        'content-type': contentTypeFor(abs),
        'cache-control': 'private, max-age=86400',
      });
    }

    const hit = STATIC[url.pathname];
    if (hit && (req.method === 'GET' || req.method === 'HEAD')) {
      const [file, type, cache] = hit;
      return send(res, 200, fs.readFileSync(file), { 'content-type': type, 'cache-control': cache });
    }

    return send(res, 404, 'not found');
  } catch (err) {
    if (err.code === 'TOO_LARGE') return sendJson(res, 413, { error: '内容过大' });
    if (err.code === 'BAD_JSON') return sendJson(res, 400, { error: 'bad json' });
    if (err.code === 'BAD_TYPE') return sendJson(res, 415, { error: '只收 jpg/png/webp/gif 图片' });
    if (err.code === 'BAD_SIZE') return sendJson(res, 400, { error: '图片为空或超过 10MB' });
    console.error(`[tapmux] ${req.method} ${url.pathname} 失败:`, err.message);
    return sendJson(res, 500, { error: 'internal error' });
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch {}
});

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => { try { socket.destroy(); } catch {} });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const auth = checkAuth(req, config.token);
  if (url.pathname !== '/ws/attach' || !auth.ok || auth.redirect || !(isInternal(req) || originOk(req))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const name = url.searchParams.get('session') || '';
  if (!validSessionName(name) || !store.has(name)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const cols = Math.min(Math.max(parseInt(url.searchParams.get('cols'), 10) || 80, 10), 500);
  const rows = Math.min(Math.max(parseInt(url.searchParams.get('rows'), 10) || 24, 4), 300);
  wss.handleUpgrade(req, socket, head, (ws) => {
    console.log(`[tapmux] attach ${name} from ${clientIp(req)}`);
    handleAttach(ws, name, { cols, rows });
  });
});

cleanupOldUploads(config.uploadDir, config.uploadRetentionDays);
setInterval(() => cleanupOldUploads(config.uploadDir, config.uploadRetentionDays), 24 * 3600 * 1000).unref();

const notifier = new Notifier(config, { probe, capture: capturePane, detect: detectClaudeState, fingerprint: contentFingerprint });
if (notifier.enabled()) {
  setInterval(() => notifier.tick(), 15_000).unref();
  console.log('[tapmux] Telegram 通知巡检已启用(15s 一拍)');
}

const internalSecret = crypto.randomBytes(16).toString('hex');
setInternalSecret(internalSecret);
startAgent(config, { internalSecret });

server.listen(config.port, config.bind, () => {
  const ifaces = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
  console.log(`[tapmux] listening on ${config.bind}:${config.port}`);
  console.log(`[tapmux] config: ${CONFIG_FILE}`);
  for (const i of ifaces) {
    console.log(`[tapmux] 访问入口: http://${i.address}:${config.port}/?token=${config.token}`);
  }
});
