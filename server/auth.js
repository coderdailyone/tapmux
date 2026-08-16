import crypto from 'node:crypto';

const COOKIE_NAME = 'tapmux_token';

// 进程内信任密钥:每次启动随机生成,仅同进程的 relay agent 持有。
// 带此头的请求 = 从本进程 agent 的隧道来的、已在 relay 层完成用户鉴权的流量。
let internalSecret = null;
export function setInternalSecret(s) {
  internalSecret = s;
}
export function isInternal(req) {
  const h = req.headers['x-tapmux-internal'];
  return Boolean(h && internalSecret && tokensEqual(String(h), internalSecret));
}

// 登录失败退避:ip -> { fails, blockedUntil }
const attempts = new Map();
const MAX_FAILS = 5;
const BLOCK_BASE_MS = 60_000;

export function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function clientIp(req) {
  const sock = req.socket.remoteAddress || 'unknown';
  // 只有本机代理(caddy 经 frp 落到 127.0.0.1)转发来的 XFF 才可信
  if (sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1') {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return sock;
}

function isBlocked(ip) {
  const a = attempts.get(ip);
  return a && a.blockedUntil && Date.now() < a.blockedUntil;
}

function recordFail(ip) {
  const a = attempts.get(ip) || { fails: 0, blockedUntil: 0 };
  a.fails += 1;
  if (a.fails >= MAX_FAILS) {
    const rounds = a.fails - MAX_FAILS;
    a.blockedUntil = Date.now() + BLOCK_BASE_MS * 2 ** Math.min(rounds, 6);
  }
  attempts.set(ip, a);
}

function recordOk(ip) {
  attempts.delete(ip);
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// 校验请求;url 上带 ?token= 且正确时返回 setCookie 指示
export function checkAuth(req, token) {
  const internal = req.headers['x-tapmux-internal'];
  if (internal && internalSecret && tokensEqual(String(internal), internalSecret)) {
    return { ok: true };
  }

  const ip = clientIp(req);
  if (isBlocked(ip)) return { ok: false, blocked: true };

  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE_NAME] && tokensEqual(cookies[COOKIE_NAME], token)) {
    recordOk(ip);
    return { ok: true };
  }

  const url = new URL(req.url, 'http://x');
  const qtoken = url.searchParams.get('token');
  if (qtoken !== null) {
    if (tokensEqual(qtoken, token)) {
      recordOk(ip);
      url.searchParams.delete('token');
      return {
        ok: true,
        setCookie: `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${180 * 24 * 3600}`,
        redirect: url.pathname + (url.search || '') + (url.hash || ''),
      };
    }
    recordFail(ip);
  }
  return { ok: false };
}

// 非安全方法与 WS 升级:若带 Origin,其 host 必须与 Host 一致(防跨站)
export function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
