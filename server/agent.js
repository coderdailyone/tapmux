import http from 'node:http';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { T, encode, encodeJson, decode, parseJson, cleanHeaders } from './relay/protocol.js';

const VERSION = createRequire(import.meta.url)('../package.json').version;

// relay 接入 agent:主动外连 relay,把隧道里的请求回环转发给本机桥接服务。
// 复用本机的全部鉴权与逻辑——agent 对业务零感知,只搬字节。
export function startAgent(config, { log = console, internalSecret = '' } = {}) {
  const r = config.relay || {};
  if (!r.url || !r.deviceName || !r.deviceToken) return null;

  // 隧道来的请求盖进程内密钥章:桥接凭它放行(用户已在 relay 层验过)
  const stamp = (headers) => {
    const h = { ...headers };
    delete h['x-tapmux-internal'];
    if (internalSecret) h['x-tapmux-internal'] = internalSecret;
    return h;
  };

  const localPort = config.port;
  let ws = null;
  let backoff = 1000;
  let alive = true;
  let hb = null;
  const streams = new Map(); // sid -> { req, local }

  const send = (buf) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf); };

  function cleanup(sid) {
    const s = streams.get(sid);
    if (!s) return;
    streams.delete(sid);
    try { s.req?.destroy(); } catch {}
    try { s.local?.terminate(); } catch {}
  }

  function connect() {
    const url = `${r.url.replace(/\/$/, '')}/relay/agent`;
    const opts = {
      headers: { 'x-device-name': r.deviceName, 'x-device-token': r.deviceToken, 'x-tapmux-version': VERSION },
      handshakeTimeout: 15_000,
    };
    if (r.proxyUrl) opts.agent = new HttpsProxyAgent(r.proxyUrl);
    ws = new WebSocket(url, opts);

    ws.on('open', () => {
      backoff = 1000;
      alive = true;
      log.log(`[tapmux] relay 已接通: ${r.url} (设备 ${r.deviceName})`);
      clearInterval(hb);
      let missed = 0;
      hb = setInterval(() => {
        if (alive) {
          missed = 0;
        } else {
          missed += 1;
          if (missed >= 3) { // 连续 3 拍(~75s)才判死:单次 pong 迟到不误杀隧道
            log.error(`[tapmux] relay 心跳连续 ${missed} 拍失联,重连`);
            try { ws.terminate(); } catch {}
            return;
          }
        }
        alive = false;
        try { ws.ping(); } catch {}
      }, 25_000);
    });
    ws.on('pong', () => { alive = true; });

    ws.on('message', (raw, isBinary) => {
      if (!isBinary) return;
      const f = decode(raw);
      if (!f) return;
      const { type, sid, payload } = f;

      if (type === T.REQ) {
        const meta = parseJson(payload);
        if (!meta) return;
        const req = http.request({
          host: '127.0.0.1', port: localPort, path: meta.path, method: meta.method,
          headers: { ...stamp(meta.headers), host: `127.0.0.1:${localPort}` },
        }, (res) => {
          send(encodeJson(T.RES_HEAD, sid, { status: res.statusCode, headers: cleanHeaders(res.headers) }));
          res.on('data', (c) => send(encode(T.RES_BODY, sid, c)));
          res.on('end', () => { send(encode(T.RES_END, sid)); cleanup(sid); });
        });
        req.on('error', () => {
          send(encodeJson(T.RES_HEAD, sid, { status: 502, headers: { 'content-type': 'text/plain' } }));
          send(encode(T.RES_END, sid));
          cleanup(sid);
        });
        streams.set(sid, { req });
      } else if (type === T.REQ_BODY) {
        streams.get(sid)?.req?.write(payload);
      } else if (type === T.REQ_END) {
        streams.get(sid)?.req?.end();
      } else if (type === T.WS_OPEN) {
        const meta = parseJson(payload);
        if (!meta) return;
        const local = new WebSocket(`ws://127.0.0.1:${localPort}${meta.path}`, { headers: stamp(meta.headers) });
        streams.set(sid, { local });
        local.on('open', () => send(encodeJson(T.WS_ACK, sid, { ok: true })));
        local.on('message', (data, bin) => send(encode(bin ? T.WS_BIN : T.WS_TXT, sid, bin ? data : Buffer.from(String(data)))));
        local.on('close', (code, reason) => { send(encodeJson(T.WS_CLOSE, sid, { code, reason: String(reason) })); cleanup(sid); });
        local.on('error', () => { send(encodeJson(T.WS_ACK, sid, { ok: false })); cleanup(sid); });
      } else if (type === T.WS_TXT || type === T.WS_BIN) {
        const local = streams.get(sid)?.local;
        if (local && local.readyState === WebSocket.OPEN) local.send(payload, { binary: type === T.WS_BIN });
      } else if (type === T.WS_CLOSE) {
        const meta = parseJson(payload) || {};
        try { streams.get(sid)?.local?.close(meta.code || 1000, meta.reason || ''); } catch {}
        cleanup(sid);
      } else if (type === T.ABORT) {
        cleanup(sid);
      }
    });

    const retry = () => {
      clearInterval(hb);
      for (const sid of [...streams.keys()]) cleanup(sid);
      if (!startAgent.stopped) {
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 1.7, 30_000);
      }
    };
    ws.on('close', (code, reason) => {
      log.error(`[tapmux] relay 断开 code=${code} reason=${String(reason) || '(无)'},${Math.round(backoff / 1000)}s 后重连`);
      retry();
    });
    ws.on('error', (err) => { log.error('[tapmux] relay 连接错误:', err.message); try { ws.terminate(); } catch {} });
  }

  connect();
  return { stop: () => { startAgent.stopped = true; try { ws?.terminate(); } catch {} } };
}
