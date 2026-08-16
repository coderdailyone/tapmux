import { detectClaudeState } from './preview.js';

// ---- 纯函数部分(可测)----

export const MACRO_LIMITS = { maxPerSession: 8, maxPattern: 200, maxText: 500, minIntervalSec: 60, minCooldownSec: 60 };

export function validateMacros(list) {
  if (!Array.isArray(list) || list.length > MACRO_LIMITS.maxPerSession) return '宏数量超限';
  for (const m of list) {
    if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 40) return '宏名称非法';
    if (typeof m.action?.text !== 'string' || !m.action.text.trim() || m.action.text.length > MACRO_LIMITS.maxText) return '指令内容非法';
    const t = m.trigger || {};
    if (t.type === 'interval') {
      if (!Number.isInteger(t.everySec) || t.everySec < MACRO_LIMITS.minIntervalSec) return `定时间隔至少 ${MACRO_LIMITS.minIntervalSec} 秒`;
    } else if (t.type === 'missing' || t.type === 'present') {
      if (typeof t.pattern !== 'string' || !t.pattern.trim() || t.pattern.length > MACRO_LIMITS.maxPattern) return '匹配字样非法';
      try { new RegExp(t.pattern); } catch { return '匹配字样不是合法正则'; }
    } else {
      return '触发类型非法';
    }
    if (m.cooldownSec !== undefined && (!Number.isInteger(m.cooldownSec) || m.cooldownSec < MACRO_LIMITS.minCooldownSec)) {
      return `冷却至少 ${MACRO_LIMITS.minCooldownSec} 秒`;
    }
  }
  return null;
}

// 有人正在输入框里打字?(❯ 后跟着非空内容)——宏绝不跟人抢键盘
export function inputBusy(text) {
  // [^\S\n] = 行内空白:不许 \s 跨行把下一行内容误判进输入框。
  // Claude Code 空输入框会显示占位提示(❯ Try "create a util...")——那是空,不是有人在打字。
  const m = /^[❯›][^\S\n]+(\S.*)$/m.exec(String(text));
  if (!m) return false;
  return !/^Try "/.test(m[1]);
}

// 该不该触发:返回 true/false(不含安全门,安全门在引擎里)
export function shouldFire(macro, screenText, now) {
  const last = macro.lastFiredAt || 0;
  const cooldownMs = (macro.cooldownSec ?? 300) * 1000;
  if (now - last < cooldownMs) return false;
  const t = macro.trigger || {};
  if (t.type === 'interval') return now - last >= t.everySec * 1000;
  const re = new RegExp(t.pattern, 'm');
  const hit = re.test(String(screenText));
  return t.type === 'missing' ? !hit : hit;
}

// ---- 引擎 ----

export class MacroEngine {
  constructor({ store, capture, sendText, sendKeys, log = console }) {
    this.store = store;
    this.capture = capture;
    this.sendText = sendText;
    this.sendKeys = sendKeys;
    this.log = log;
    this.busy = false;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const name of this.store.names()) {
        const entry = this.store.managed.get(name);
        const macros = (entry?.macros || []).filter((m) => m.enabled !== false);
        if (!macros.length) continue;
        await this.observe(name, entry, macros).catch((err) => {
          this.log.error(`[tapmux] 宏巡检失败 ${name}:`, err.message);
        });
      }
    } finally {
      this.busy = false;
    }
  }

  async observe(name, entry, macros) {
    let text;
    try {
      text = await this.capture(name);
    } catch {
      return; // 会话不在(已死),不动
    }
    // 安全门:只在空闲态、且没人正在打字时注入
    if (detectClaudeState(text) !== 'idle' || inputBusy(text)) return;

    const now = Date.now();
    for (const m of macros) {
      if (!shouldFire(m, text, now)) continue;
      m.lastFiredAt = now;
      this.store.save();
      this.log.log(`[tapmux] 宏触发 ${name}/${m.name}`);
      await this.sendText(name, m.action.text, { enter: m.action.enter !== false });
      if (m.action.confirmEnter) {
        await new Promise((r) => setTimeout(r, 1800));
        const after = await this.capture(name).catch(() => '');
        if (detectClaudeState(after) === 'waiting') {
          await this.sendKeys(name, ['Enter']);
          this.log.log(`[tapmux] 宏补确认 ${name}/${m.name}`);
        }
      }
      break; // 每拍每会话至多一发,避免连环注入互相踩
    }
  }
}
