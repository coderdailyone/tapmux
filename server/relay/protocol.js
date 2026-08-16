// relay <-> agent 的多路复用帧协议(跑在一条 WebSocket 上)
// 帧 = [1B 类型][4B 流ID BE][负载]
export const T = {
  REQ: 0x01,       // relay→agent: 开 HTTP 流,负载 JSON {method,path,headers}
  REQ_BODY: 0x02,  // relay→agent: 请求体分片
  REQ_END: 0x03,   // relay→agent: 请求体完
  RES_HEAD: 0x04,  // agent→relay: 负载 JSON {status,headers}
  RES_BODY: 0x05,  // agent→relay: 响应体分片
  RES_END: 0x06,   // agent→relay: 响应完
  ABORT: 0x07,     // 双向:强拆此流
  WS_OPEN: 0x10,   // relay→agent: 开 WS 流,负载 JSON {path,headers}
  WS_ACK: 0x11,    // agent→relay: 负载 JSON {ok}
  WS_TXT: 0x12,    // 双向:WS 文本消息
  WS_BIN: 0x13,    // 双向:WS 二进制消息
  WS_CLOSE: 0x14,  // 双向:负载 JSON {code,reason}
};

export const MAX_FRAME = 2 * 1024 * 1024;

export function encode(type, sid, payload = Buffer.alloc(0)) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (p.length > MAX_FRAME) throw new Error('frame too large');
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(sid >>> 0, 1);
  return Buffer.concat([head, p]);
}

export function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5) return null;
  return { type: buf.readUInt8(0), sid: buf.readUInt32BE(1), payload: buf.subarray(5) };
}

export function encodeJson(type, sid, obj) {
  return encode(type, sid, Buffer.from(JSON.stringify(obj)));
}

export function parseJson(payload) {
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
}

// 转发 HTTP 头时的清洗:逐跳头不过隧道
const HOP = new Set(['connection', 'upgrade', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'host', 'content-length']);
export function cleanHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!HOP.has(k.toLowerCase()) && v !== undefined) out[k] = v;
  }
  return out;
}
