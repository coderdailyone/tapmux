#!/usr/bin/env node
// tapmux relay:一台公网机承接多台内网 tapmux 设备(邀请码注册制)。
//   tapmux-relay              启动服务(默认 127.0.0.1:7803,放在你的反代之后)
//   tapmux-relay invite       生成一枚单次邀请码
//   tapmux-relay devices      设备清单
//   tapmux-relay revoke <名>  吊销设备
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Registry } from '../server/relay/registry.js';
import { T, encode, encodeJson, decode, parseJson, cleanHeaders } from '../server/relay/protocol.js';

const DATA_DIR = process.env.TAPMUX_RELAY_DATA || path.join(os.homedir(), '.config', 'tapmux-relay');
const PORT = Number(process.env.TAPMUX_RELAY_PORT || 7803);
const BIND = process.env.TAPMUX_RELAY_BIND || '127.0.0.1';
const STREAM_TIMEOUT_MS = 30_000;
const MAX_STREAMS = 64;

const registry = new Registry(DATA_DIR);

const cmd = process.argv[2];
if (cmd === 'user-add') {
  const out = registry.createUser(process.argv[3]);
  if (out.error) { console.error(out.error); process.exit(1); }
  console.log(`用户 ${out.name} 已创建`);
  console.log(`用户 token(仅此一次,按 SSH 私钥对待): ${out.userToken}`);
  console.log(`手机登录: https://你的域名/relay/login?token=${out.userToken}`);
  process.exit(0);
} else if (cmd === 'users') {
  for (const u of registry.listUsers()) console.log(`${u.name}\t机器: ${u.devices.join(', ') || '(无)'}`);
  process.exit(0);
} else if (cmd === 'user-revoke') {
  console.log(registry.revokeUser(process.argv[3]) ? '已吊销(名下机器保留,可 claim 给别人)' : '用户不存在');
  process.exit(0);
} else if (cmd === 'claim') {
  console.log(registry.claimDevice(process.argv[3], process.argv[4]) ? '已归属' : '设备或用户不存在');
  process.exit(0);
} else if (cmd === 'invite') {
  const out = registry.createInvite(process.argv[3]);
  if (out.error) { console.error(`${out.error}(用法: tapmux-relay invite <用户名>)`); process.exit(1); }
  console.log(`邀请码(单次有效,机器将挂到用户 ${process.argv[3]} 名下): ${out.code}`);
  console.log('内网机上执行: tapmux relay-join <https://你的域名> <邀请码> <设备名>');
  process.exit(0);
} else if (cmd === 'devices') {
  for (const d of registry.list()) {
    const seen = d.lastSeen ? new Date(d.lastSeen).toISOString() : '从未';
    console.log(`${d.name}\t属主: ${d.owner || '(无)'}\t最后在线: ${seen}`);
  }
  process.exit(0);
} else if (cmd === 'revoke') {
  console.log(registry.revoke(process.argv[3]) ? '已吊销' : '设备不存在');
  process.exit(0);
} else if (cmd !== undefined) {
  console.error('用法: tapmux-relay [user-add <名>|users|user-revoke <名>|invite <用户>|claim <设备> <用户>|devices|revoke <设备>]');
  process.exit(1);
}

// ---- 用户鉴权(cookie 存用户 token,每请求对哈希)+ 登录失败退避 ----
const USER_COOKIE = 'tapmux_user';
const fails = new Map(); // ip -> {n, until}
function clientIp(req) {
  const sock = req.socket.remoteAddress || '';
  if (sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1') {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return sock;
}
function blocked(ip) {
  const f = fails.get(ip);
  return f && f.until > Date.now();
}
function fail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) f.until = Date.now() + 60_000 * 2 ** Math.min(f.n - 5, 6);
  fails.set(ip, f);
}
function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
function userFromReq(req) {
  registry.reload();
  return registry.authUser(cookieOf(req, USER_COOKIE));
}
function sendHtml(res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;padding:32px 20px;background:#0b0f14;color:#e8eef5;font-family:-apple-system,'PingFang SC',sans-serif">${body}`);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- 在线设备表:name -> { ws, streams: Map<sid, handler>, nextSid } ----
const online = new Map();

function agentSend(dev, buf) {
  if (dev.ws.readyState === WebSocket.OPEN) dev.ws.send(buf);
}

function openStream(dev, handler, { ws = false } = {}) {
  if (dev.streams.size >= MAX_STREAMS) return null;
  const sid = dev.nextSid = (dev.nextSid % 0xfffffff) + 1;
  const s = { sid, ...handler, timer: null };
  // WS 流(如终端 attach)可以长时间静默,不设不活动超时;HTTP 流 30s 兜底
  s.bump = ws ? () => {} : () => {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => closeStream(dev, sid, true), STREAM_TIMEOUT_MS);
  };
  s.bump();
  dev.streams.set(sid, s);
  return s;
}

function closeStream(dev, sid, abort = false) {
  const s = dev.streams.get(sid);
  if (!s) return;
  clearTimeout(s.timer);
  dev.streams.delete(sid);
  if (abort) agentSend(dev, encode(T.ABORT, sid));
  try { s.onAbort?.(); } catch {}
}

function readJsonBody(req, limit = 16 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n <= limit) chunks.push(c); });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'POST' && url.pathname === '/relay/register') {
    const body = await readJsonBody(req);
    registry.reload();
    const out = body ? registry.register(body.invite, body.name) : { error: 'bad json' };
    res.writeHead(out.error ? 400 : 200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === '/relay/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, devices: [...online.keys()] }));
    return;
  }

  if (url.pathname === '/relay/login') {
    const ip = clientIp(req);
    if (blocked(ip)) { sendHtml(res, 429, '尝试过多,稍后再试'); return; }
    const t = url.searchParams.get('token');
    if (t !== null) {
      registry.reload();
      const user = registry.authUser(t);
      if (user) {
        sendHtml(res, 302, '', {
          'set-cookie': `${USER_COOKIE}=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${180 * 24 * 3600}`,
          location: '/relay/',
        });
        return;
      }
      fail(ip);
    }
    sendHtml(res, 401, `<h2 style="margin:0 0 16px">tapmux</h2>
      <form method="GET" action="/relay/login">
      <input name="token" placeholder="用户 token" autocapitalize="off" autocorrect="off"
        style="width:100%;max-width:420px;box-sizing:border-box;background:#161e28;border:1px solid #223041;border-radius:12px;color:#e8eef5;font-size:16px;padding:12px">
      <button style="margin-top:12px;display:block;background:#34d399;color:#06281c;border:0;border-radius:12px;padding:12px 20px;font-size:15px;font-weight:700">登录</button>
      </form>`);
    return;
  }

  if (url.pathname === '/relay/logout') {
    sendHtml(res, 302, '', { 'set-cookie': `${USER_COOKIE}=; Path=/; Max-Age=0`, location: '/relay/login' });
    return;
  }

  if (url.pathname === '/relay/' || url.pathname === '/relay') {
    const user = userFromReq(req);
    if (!user) { sendHtml(res, 302, '', { location: '/relay/login' }); return; }
    const mine = registry.list().filter((d) => d.owner === user);
    const rows = mine.map((d) => {
      const on = online.has(d.name);
      return `<a href="/d/${esc(d.name)}/" style="display:flex;align-items:center;gap:12px;background:#161e28;border:1px solid #223041;border-radius:16px;padding:16px;margin-bottom:10px;color:#e8eef5;text-decoration:none;max-width:480px">
        <span style="width:10px;height:10px;border-radius:50%;background:${on ? '#34d399' : '#f87171'}"></span>
        <b style="font-size:17px">${esc(d.name)}</b>
        <span style="color:#8b9bab;font-size:13px;margin-left:auto">${on ? '在线' : '离线'}</span></a>`;
    }).join('') || '<p style="color:#8b9bab">名下还没有机器,用邀请码接一台吧。</p>';
    sendHtml(res, 200, `<h2 style="margin:0 0 4px"><span style="color:#34d399;font-family:ui-monospace,monospace">❯</span> 我的机器</h2>
      <p style="color:#8b9bab;margin:0 0 20px;font-size:13px">${esc(user)} · <a href="/relay/logout" style="color:#8b9bab">退出</a></p>${rows}`);
    return;
  }

  const m = /^\/d\/([a-z0-9][a-z0-9-]{0,23})(\/.*)?$/.exec(url.pathname);
  if (!m) { res.writeHead(404); res.end('not found'); return; }
  const [, name, rest] = m;
  if (rest === undefined) { // /d/name -> /d/name/(相对路径前端的锚点)
    res.writeHead(301, { location: `/d/${name}/` });
    res.end();
    return;
  }
  // 用户门禁:登录 + 属主匹配
  const user = userFromReq(req);
  if (!user) {
    if (rest.startsWith('/api/') || rest.startsWith('/ws/')) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); }
    else sendHtml(res, 302, '', { location: '/relay/login' });
    return;
  }
  if (registry.ownerOf(name) !== user) { sendHtml(res, 403, '这台机器不在你名下'); return; }
  // 跨站防护(桥接端对隧道流量已放行,由这里守):非安全方法带 Origin 时必须同源
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
    let ok = false;
    try { ok = new URL(req.headers.origin).host === req.headers.host; } catch {}
    if (!ok) { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"bad origin"}'); return; }
  }

  const dev = online.get(name);
  if (!dev) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('设备离线'); return; }

  const headers = cleanHeaders(req.headers);
  delete headers['x-tapmux-user'];
  delete headers['x-tapmux-internal']; // 防伪:这两个头只能由链路自己盖
  headers['x-tapmux-user'] = user;
  const xff = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  headers['x-forwarded-for'] = String(xff);

  const s = openStream(dev, {
    onHead: (h) => { s.bump(); res.writeHead(h.status, h.headers); },
    onBody: (b) => { s.bump(); res.write(b); },
    onEnd: () => { closeStream(dev, s.sid); res.end(); },
    onAbort: () => { if (!res.headersSent) res.writeHead(504); res.end(); },
  });
  if (!s) { res.writeHead(503); res.end('busy'); return; }
  res.on('close', () => closeStream(dev, s.sid, true));

  agentSend(dev, encodeJson(T.REQ, s.sid, { method: req.method, path: rest + url.search, headers }));
  req.on('data', (c) => agentSend(dev, encode(T.REQ_BODY, s.sid, c)));
  req.on('end', () => agentSend(dev, encode(T.REQ_END, s.sid)));
});

// ---- WebSocket:/relay/agent(设备上行)与 /d/<name>/...(访客 WS,如终端 attach) ----
const wssAgent = new WebSocketServer({ noServer: true });
const wssPublic = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => { try { socket.destroy(); } catch {} });
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/relay/agent') {
    const name = String(req.headers['x-device-name'] || '');
    const token = String(req.headers['x-device-token'] || '');
    registry.reload();
    if (!registry.auth(name, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wssAgent.handleUpgrade(req, socket, head, (ws) => {
      const old = online.get(name);
      if (old) { try { old.ws.terminate(); } catch {} }
      const dev = { ws, streams: new Map(), nextSid: 0 };
      online.set(name, dev);
      registry.touch(name);
      console.log(`[relay] 设备上线: ${name}`);
      ws.on('message', (raw, isBinary) => {
        if (!isBinary) return;
        const f = decode(raw);
        if (!f) return;
        const s = dev.streams.get(f.sid);
        if (!s) return;
        if (f.type === T.RES_HEAD) s.onHead?.(parseJson(f.payload) || { status: 502, headers: {} });
        else if (f.type === T.RES_BODY) s.onBody?.(f.payload);
        else if (f.type === T.RES_END) s.onEnd?.();
        else if (f.type === T.WS_ACK) s.onAck?.(parseJson(f.payload) || { ok: false });
        else if (f.type === T.WS_TXT) s.onWsData?.(f.payload.toString('utf8'), false);
        else if (f.type === T.WS_BIN) s.onWsData?.(f.payload, true);
        else if (f.type === T.WS_CLOSE) s.onWsClose?.(parseJson(f.payload) || {});
        else if (f.type === T.ABORT) closeStream(dev, f.sid);
      });
      const hb = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 25_000);
      ws.on('close', () => {
        clearInterval(hb);
        for (const sid of [...dev.streams.keys()]) closeStream(dev, sid);
        if (online.get(name) === dev) {
          online.delete(name);
          registry.touch(name);
          console.log(`[relay] 设备离线: ${name}`);
        }
      });
      ws.on('error', () => { try { ws.terminate(); } catch {} });
    });
    return;
  }

  const m = /^\/d\/([a-z0-9][a-z0-9-]{0,23})(\/.*)$/.exec(url.pathname);
  if (!m) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
  const [, name, rest] = m;
  const wsUser = userFromReq(req);
  if (!wsUser || registry.ownerOf(name) !== wsUser) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (req.headers.origin) {
    let ok = false;
    try { ok = new URL(req.headers.origin).host === req.headers.host; } catch {}
    if (!ok) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  }
  const dev = online.get(name);
  if (!dev) { socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); socket.destroy(); return; }

  wssPublic.handleUpgrade(req, socket, head, (client) => {
    const headers = cleanHeaders(req.headers);
    delete headers['x-tapmux-user'];
    delete headers['x-tapmux-internal'];
    headers['x-tapmux-user'] = wsUser;
    const s = openStream(dev, {
      onAck: (a) => {
        s.bump();
        if (!a.ok) { client.close(1011, 'device refused'); closeStream(dev, s.sid); }
      },
      onWsData: (data, isBinary) => { s.bump(); if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary }); },
      onWsClose: (c) => { closeStream(dev, s.sid); try { client.close(c.code || 1000, c.reason || ''); } catch {} },
      onAbort: () => { try { client.terminate(); } catch {} },
    }, { ws: true });
    if (!s) { client.close(1013, 'busy'); return; }
    agentSend(dev, encodeJson(T.WS_OPEN, s.sid, { path: rest + url.search, headers }));
    client.on('message', (data, isBinary) => {
      s.bump();
      agentSend(dev, encode(isBinary ? T.WS_BIN : T.WS_TXT, s.sid, isBinary ? data : Buffer.from(String(data))));
    });
    client.on('close', (code, reason) => {
      agentSend(dev, encodeJson(T.WS_CLOSE, s.sid, { code, reason: String(reason) }));
      closeStream(dev, s.sid);
    });
    client.on('error', () => { try { client.terminate(); } catch {} });
  });
});

server.listen(PORT, BIND, () => {
  console.log(`[relay] listening on ${BIND}:${PORT}, data: ${DATA_DIR}`);
});
