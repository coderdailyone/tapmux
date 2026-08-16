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
if (cmd === 'invite') {
  console.log(`邀请码(单次有效): ${registry.createInvite()}`);
  console.log('内网机上执行: tapmux relay-join <https://你的域名> <邀请码> <设备名>');
  process.exit(0);
} else if (cmd === 'devices') {
  for (const d of registry.list()) {
    const seen = d.lastSeen ? new Date(d.lastSeen).toISOString() : '从未';
    console.log(`${d.name}\t最后在线: ${seen}`);
  }
  process.exit(0);
} else if (cmd === 'revoke') {
  console.log(registry.revoke(process.argv[3]) ? '已吊销' : '设备不存在');
  process.exit(0);
} else if (cmd !== undefined) {
  console.error('用法: tapmux-relay [invite|devices|revoke <名>]');
  process.exit(1);
}

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

  const m = /^\/d\/([a-z0-9][a-z0-9-]{0,23})(\/.*)?$/.exec(url.pathname);
  if (!m) { res.writeHead(404); res.end('not found'); return; }
  const [, name, rest] = m;
  if (rest === undefined) { // /d/name -> /d/name/(相对路径前端的锚点)
    res.writeHead(301, { location: `/d/${name}/` });
    res.end();
    return;
  }
  const dev = online.get(name);
  if (!dev) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('设备离线'); return; }

  const headers = cleanHeaders(req.headers);
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
  const dev = online.get(name);
  if (!dev) { socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); socket.destroy(); return; }

  wssPublic.handleUpgrade(req, socket, head, (client) => {
    const headers = cleanHeaders(req.headers);
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
