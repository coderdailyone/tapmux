import crypto from 'node:crypto';
import { detectClaudeState } from './preview.js';
import { inputBusy } from './macros.js';

// Agent 控制面:让外部 agent(另一个 Claude 会话、脚本)安全地往纳管会话里下指令。
// 与宏共用同一道安全门(只在空闲、没人打字时动手)与同一把会话锁(互不踩键)。

// ---- 纯函数部分(可测)----

// 屏幕末尾 n 行(去掉 capture 尾部的空行)
export function screenTail(text, n = 40) {
  const lines = String(text).replace(/\s+$/, '').split('\n');
  return lines.slice(-n).join('\n');
}

// 状态条上的模型名,如 "  [Fable 5.1] │ root │ ⏱️ 2m" → "Fable 5.1"(取最后一处,状态条在底部)
export function statusModel(text) {
  const all = [...String(text).matchAll(/^\s*\[((?:Fable|Opus|Sonnet|Haiku)\b[^\]]{0,40})\]/gm)];
  return all.length ? all[all.length - 1][1].trim() : null;
}

// Claude Code 的 /model 选择器:
//      1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks
//    ❯ 3.  Fable 5.1 ✔            For your toughest challenges
//    ↓ 10. Opus 4.8               Best for everyday, complex tasks
// 只解析最后一个 "Select model" 之后的部分,免得把正文里的编号列表当选项。
export function parseModelMenu(text) {
  const s = String(text);
  const at = s.lastIndexOf('Select model');
  if (at < 0) return { open: false, options: [], highlighted: null, sessionOnly: false, total: 0 };
  const tail = s.slice(at);
  const options = [];
  let highlighted = null;
  for (const line of tail.split('\n')) {
    const m = /^\s*(?:([❯›↑↓])\s*)?(\d+)\.\s+(.+?)(?:\s{2,}|$)/.exec(line);
    if (!m) continue;
    const n = Number(m[2]);
    const label = m[3].replace(/\s*✔\s*$/, '').trim();
    const current = /✔/.test(m[3]);
    options.push({ n, label, current });
    if (m[1] === '❯' || m[1] === '›') highlighted = n;
  }
  // 提示行在窄屏会折行,只认关键字
  const sessionOnly = /use this session/.test(tail);
  // "… +3 models" = 屏下还藏着几项;编号是绝对的,所以总数 = 屏上最大编号 + 藏着的
  const more = Number((/…\s*\+(\d+) models?\b/.exec(tail) || [])[1] || 0);
  const total = options.length ? Math.max(...options.map((o) => o.n)) + more : 0;
  return { open: options.length > 0, options, highlighted, sessionOnly, total };
}

// 用户/agent 说的模型 → 归一成选择器标签的小写形式:
// claude-fable-5-1 / fable-5-1 / fable5.1 → "fable 5.1";fable → "fable"(取该家族最新);[1m] 单独记
export function normalizeModelQuery(q) {
  let s = String(q || '').trim().toLowerCase();
  const want1m = /\[1m\]|\b1m\b/.test(s);
  s = s.replace(/\[1m\]/g, '').replace(/\(1m context\)/g, '').replace(/^claude-/, '').replace(/-\d{8}$/, '').trim();
  const m = /^(fable|opus|sonnet|haiku)[\s-]?(\d+)?(?:[-.](\d+))?$/.exec(s);
  if (m) s = [m[1], m[2] && (m[3] ? `${m[2]}.${m[3]}` : m[2])].filter(Boolean).join(' ');
  return { q: s, want1m };
}

// 在选项里找目标:精确 > 只给了家族名时取列表里第一个(选择器按新旧排,第一个即最新) > 前缀
export function resolveModel(options, query) {
  const { q, want1m } = normalizeModelQuery(query);
  if (!q) return null;
  const norm = (label) => label.toLowerCase().replace(/\s*\(1m context\)/, '').trim();
  const pool = options.filter((o) => /1m context/i.test(o.label) === want1m);
  const cands = pool.length ? pool : options;
  if (q === 'default') return cands.find((o) => /^default\b/i.test(o.label)) || null;
  const exact = cands.find((o) => norm(o.label) === q);
  if (exact) return exact;
  if (/^(fable|opus|sonnet|haiku)$/.test(q)) return cands.find((o) => norm(o.label).split(' ')[0] === q) || null;
  return cands.find((o) => norm(o.label).startsWith(`${q}.`) || norm(o.label).startsWith(`${q} `)) || null;
}

// 本次 /model 的结果行:紧跟在最后一个 "❯ /model" 回显下面的 ⎿ 行。
// 屏幕上更早的 "Set model to …" 是历次残留,状态条也要 0.5~1s 才刷新,都不能当证据。
export function parseModelSaid(text) {
  const lines = String(text).split('\n');
  let at = -1;
  lines.forEach((l, i) => { if (/^[❯›]\s*\/model\s*$/.test(l)) at = i; });
  if (at < 0) return null;
  for (const l of lines.slice(at + 1, at + 5)) {
    const m = /(Set model to|Kept model as) `?(.+?)`?(?: for this session only| and saved as your default.*)?$/.exec(l.trim());
    if (m) return { label: m[2].replace(/\s*\(default\)$/, '').trim(), session: /for this session only/.test(l), line: l.replace(/^\s*⎿\s*/, '').trim() };
  }
  return null;
}

// 有对话历史的会话切模型会再弹一道确认(缓存作废、下条消息重读全部历史):
//    Switch model?
//    ❯ 1. Yes, switch to Sonnet 5.5
//      2. No, go back
export function parseSwitchConfirm(text) {
  const s = String(text);
  const at = s.lastIndexOf('Switch model?');
  if (at < 0) return null;
  const m = /^\s*([❯›])?\s*(\d+)\.\s+Yes, switch\b/m.exec(s.slice(at));
  return m ? { yes: m[2], highlighted: Boolean(m[1]) } : null;
}

// 发给会话的 "/model <名>" 走选择器切换(默认仅本会话),不原样敲进去——
// 原生 "/model <名>" 会顺手改掉全机的默认模型(真机踩过:一个会话切模型,所有新会话跟着变)。
export function modelCommand(text) {
  const m = /^\/model\s+(\S.*)$/.exec(String(text).trim());
  return m ? m[1].trim() : null;
}

// ---- 控制器 ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_WAIT_SEC = 15; // relay 的 HTTP 流 30s 无数据即断,单次请求里的等待要留足余量
const QUEUE_LIMIT = 10;
const RECENT_LIMIT = 20;

export class Controller {
  constructor({ capture, sendText, sendKeys, log = console }) {
    this.capture = capture;
    this.sendText = sendText;
    this.sendKeys = sendKeys;
    this.log = log;
    this.locks = new Map(); // name -> 尾部 promise
    this.queue = new Map(); // name -> [{ id, action, source, addedAt, expiresAt }]
    this.recent = new Map(); // name -> [{ at, source, action, ok, detail }]
    this.ticking = false;
  }

  // 同一会话的注入串行化:agent 指令、宏、排队项不会交错按键
  async lock(name, fn) {
    const prev = this.locks.get(name) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(name, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(name) === tail) this.locks.delete(name);
    }
  }

  busy(name) {
    return this.locks.has(name);
  }

  record(name, entry) {
    const list = this.recent.get(name) || [];
    list.push({ at: Date.now(), ...entry });
    while (list.length > RECENT_LIMIT) list.shift();
    this.recent.set(name, list);
    const what = entry.action.model ? `模型→${entry.action.model}` : entry.action.text;
    this.log.log(`[tapmux] ${entry.source} ${name}: ${what} → ${entry.ok ? 'ok' : `失败(${entry.detail})`}`);
  }

  async gateOpen(name) {
    const text = await this.capture(name);
    const state = detectClaudeState(text);
    const typing = inputBusy(text);
    return { open: state === 'idle' && !typing, state, inputBusy: typing, text };
  }

  // 等会话空闲且没人打字,最多 waitSec 秒
  async waitIdle(name, waitSec = 0) {
    const deadline = Date.now() + Math.min(Math.max(Number(waitSec) || 0, 0), MAX_WAIT_SEC) * 1000;
    for (;;) {
      const g = await this.gateOpen(name);
      if (g.open || Date.now() >= deadline) return g;
      await sleep(1000);
    }
  }

  async waitFor(name, pred, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = await this.capture(name).catch(() => '');
      if (pred(text)) return text;
      if (Date.now() >= deadline) return null;
      await sleep(200);
    }
  }

  // 执行一个动作(调用方已过安全门、已持锁)。action: { text, enter, confirm, persist } 或 { model, persist }
  async execute(name, action) {
    const model = action.model || modelCommand(action.text || '');
    if (model) return this.switchModel(name, model, { persist: action.persist === true });
    await this.sendText(name, action.text, { enter: action.enter !== false });
    if (action.confirm) {
      await sleep(1800);
      const after = await this.capture(name).catch(() => '');
      if (detectClaudeState(after) === 'waiting') {
        await this.sendKeys(name, ['Enter']);
        return { ok: true, confirmed: true };
      }
    }
    return { ok: true };
  }

  // 驱动 /model 选择器:定位目标 → s(仅本会话)或 Enter(存为默认)→ 核对结果
  async switchModel(name, query, { persist = false } = {}) {
    if (!normalizeModelQuery(query).q) return { ok: false, error: '模型名为空' };
    await this.sendText(name, '/model', { enter: true });
    const opened = await this.waitFor(name, (t) => parseModelMenu(t).open, 6000);
    if (!opened) {
      await this.sendKeys(name, ['Escape']).catch(() => {});
      return { ok: false, error: '没等到模型选择器(这个会话里跑的是 Claude Code 吗?)' };
    }
    const fail = async (error, extra = {}) => {
      await this.sendKeys(name, ['Escape']).catch(() => {});
      return { ok: false, error, ...extra };
    };
    if (!persist && !parseModelMenu(opened).sessionOnly) {
      return fail('这个版本的 Claude Code 选择器不支持「仅本会话」,要切只能连全局默认一起改(加 persist)');
    }

    // 先读全列表再挑:超出屏幕的项要翻到才看得见,只看一屏会把「fable」挑成屏内的旧版。
    // 每次把高亮移到最小的没见过的编号(不跨列表两端,免得循环滚动跳过),直到全见过。
    const seen = new Map();
    let menu = parseModelMenu(opened);
    const look = async () => {
      await sleep(150);
      menu = parseModelMenu(await this.capture(name));
      if (!menu.open || menu.highlighted === null) return false;
      for (const o of menu.options) seen.set(o.n, o);
      return true;
    };
    const moveTo = async (n) => {
      const d = n - menu.highlighted;
      if (d) await this.sendKeys(name, Array(Math.abs(d)).fill(d > 0 ? 'Down' : 'Up'));
      return look();
    };
    if (!(await look())) return fail('模型选择器意外关闭');
    const total = Math.min(menu.total, 60);
    for (let step = 0; step < 8; step++) {
      const missing = Array.from({ length: total }, (_, i) => i + 1).find((n) => !seen.has(n));
      if (!missing) break;
      if (!(await moveTo(missing))) return fail('模型选择器意外关闭');
    }
    const all = [...seen.values()].sort((a, b) => a.n - b.n);
    const target = resolveModel(all, query);
    if (!target) {
      return fail(`选择器里没有匹配「${query}」的模型`, { available: all.map((o) => o.label) });
    }
    for (let i = 0; i < 3 && menu.highlighted !== target.n; i++) {
      if (!(await moveTo(target.n))) return fail('模型选择器意外关闭');
    }
    if (menu.highlighted !== target.n) return fail(`光标停不到「${target.label}」上`);

    await this.sendKeys(name, [persist ? 'Enter' : 's']);
    const isDefault = /^Default\b/.test(target.label);
    const matches = (t) => {
      const said = !parseModelMenu(t).open && parseModelSaid(t);
      return Boolean(said) && (isDefault || said.label === target.label);
    };
    let after = await this.waitFor(name, (t) => matches(t) || parseSwitchConfirm(t), 5000);
    let cacheReset = false;
    const confirm = after && !matches(after) && parseSwitchConfirm(after);
    if (confirm) {
      // 要切就确认;代价写进返回,让 agent 告诉用户
      await this.sendKeys(name, [confirm.highlighted ? 'Enter' : confirm.yes]);
      cacheReset = true;
      after = await this.waitFor(name, matches, 5000);
    }
    if (!after) {
      const last = await this.capture(name).catch(() => '');
      if (parseSwitchConfirm(last)) { // 确认框 Esc 一次退回选择器,再一次才关
        await this.sendKeys(name, ['Escape']).catch(() => {});
        await sleep(300);
        return fail('切换确认框没过去,已取消');
      }
      if (parseModelMenu(last).open) return fail('选中后选择器没关');
      return { ok: false, error: `切完核对不上:想切 ${target.label},Claude Code 回的是「${parseModelSaid(last)?.line || '(没看到结果行)'}」` };
    }
    const said = parseModelSaid(after);
    // 等状态条刷新到新模型(没有状态条就不等),让随后的 ls/screen 看到的一致
    await this.waitFor(name, (t) => { const m = statusModel(t); return !m || m === said.label; }, 3000);
    return {
      ok: true,
      model: said.label,
      scope: persist ? 'default' : 'session',
      said: said.line,
      ...(cacheReset ? { note: '会话有上下文,已确认切换:下一条消息会按新模型重读全部历史(更慢、更费 token)' } : {}),
    };
  }

  // 一条 agent 指令的完整流程:持锁 → 安全门(可等)→ 执行 → 稍候看屏幕
  async command(name, action, { waitSec = 0, force = false, source = 'agent' } = {}) {
    return this.lock(name, async () => {
      const g = force ? { open: true } : await this.waitIdle(name, waitSec);
      if (!g.open) return { ok: false, busy: true, state: g.state, inputBusy: g.inputBusy };
      let r;
      try {
        r = await this.execute(name, action);
      } catch (err) {
        r = { ok: false, error: err.message };
      }
      this.record(name, { source, action, ok: r.ok, detail: r.error });
      await sleep(r.ok && !action.model && !modelCommand(action.text || '') ? 1200 : 300);
      const text = await this.capture(name).catch(() => '');
      return { ...r, state: detectClaudeState(text), screen: screenTail(text, 15) };
    });
  }

  // ---- 排队:会话在忙(典型:agent 给自己所在的会话下指令)时,等它空闲再执行 ----

  enqueue(name, action, { ttlSec = 7200, source = 'agent' } = {}) {
    const list = this.queue.get(name) || [];
    if (list.length >= QUEUE_LIMIT) return { error: `排队已满(${QUEUE_LIMIT})` };
    const ttl = Math.min(Math.max(Number(ttlSec) || 7200, 60), 86400);
    const item = { id: crypto.randomBytes(4).toString('hex'), action, source, addedAt: Date.now(), expiresAt: Date.now() + ttl * 1000 };
    list.push(item);
    this.queue.set(name, list);
    return { id: item.id, position: list.length };
  }

  listQueue(name) {
    return this.queue.get(name) || [];
  }

  cancel(name, id) {
    const list = this.queue.get(name) || [];
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    if (!list.length) this.queue.delete(name);
    return true;
  }

  recentOf(name) {
    return this.recent.get(name) || [];
  }

  async tickQueue() {
    if (this.ticking || !this.queue.size) return;
    this.ticking = true;
    try {
      for (const [name, list] of [...this.queue]) {
        const now = Date.now();
        for (const x of list.filter((y) => y.expiresAt <= now)) {
          this.record(name, { source: 'queue', action: x.action, ok: false, detail: '排队超时,已丢弃' });
        }
        const live = list.filter((y) => y.expiresAt > now);
        if (!live.length) { this.queue.delete(name); continue; }
        this.queue.set(name, live);
        if (this.busy(name)) continue;
        const g = await this.gateOpen(name).catch(() => null);
        if (!g || !g.open) continue;
        const item = live.shift();
        if (!live.length) this.queue.delete(name);
        const r = await this.command(name, item.action, { source: `queue(${item.source})` });
        if (r.busy) this.queue.set(name, [item, ...(this.queue.get(name) || [])]); // 门口被人抢先,放回队首

      }
    } finally {
      this.ticking = false;
    }
  }
}
