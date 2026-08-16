import { execFile } from 'node:child_process';

// 状态巡检通知器:检测纳管 Claude 会话的状态转变,推送 Telegram。
// 设计约束:任何失败都只能记日志,绝不允许波及桥接主流程。

// 纯函数:根据"已确认的旧状态 → 新状态"决定是否通知(便于测试)
export function decideNotification({ prevState, nextState, workingMs, minWorkingMs }) {
  if (prevState === nextState) return null;
  // 等确认从任何前态都要喊人:巡检间隔可能错过短暂的 working 相
  if (nextState === 'waiting') {
    return { kind: 'waiting', text: '🟠 等你确认' };
  }
  if (prevState === 'working' && nextState === 'idle') {
    if (workingMs >= minWorkingMs) return { kind: 'done', text: '✅ 干完活了' };
  }
  return null;
}

export class Notifier {
  constructor(config, { probe, capture, detect, log = console }) {
    this.cfg = config.notify || {};
    this.baseUrl = config.publicUrl || '';
    this.probe = probe;       // 取纳管会话清单
    this.capture = capture;   // 抓屏
    this.detect = detect;     // 屏幕文本 → 状态
    this.log = log;
    this.sessions = new Map(); // name -> { state, since, pending, confirm }
    this.busy = false;
  }

  enabled() {
    return Boolean(this.cfg.enabled && this.cfg.telegramBotToken && this.cfg.telegramChatId);
  }

  async tick() {
    if (!this.enabled() || this.busy) return;
    this.busy = true;
    try {
      const { managed } = await this.probe();
      const liveClaude = new Set();
      for (const m of managed) {
        if (!(m.cmds || []).includes('claude')) continue;
        liveClaude.add(m.name);
        await this.observe(m.name);
      }
      for (const name of [...this.sessions.keys()]) {
        if (!liveClaude.has(name)) this.sessions.delete(name);
      }
    } catch (err) {
      this.log.error('[tapmux] notify tick 失败:', err.message);
    } finally {
      this.busy = false;
    }
  }

  async observe(name) {
    const state = this.detect(await this.capture(name));
    const now = Date.now();
    let s = this.sessions.get(name);
    if (!s) {
      // 首见:静默登记,不为存量状态发通知
      this.sessions.set(name, { state, since: now, pending: state, confirm: 0 });
      return;
    }
    if (state !== s.pending) {
      s.pending = state;
      s.confirm = 1;
    } else if (state !== s.state) {
      s.confirm += 1;
    }
    // waiting 一拍即发(对话框稳定且要人),其他状态两拍确认防抖动
    const need = state === 'waiting' ? 1 : 2;
    if (state !== s.state && s.confirm >= need) {
      const n = decideNotification({
        prevState: s.state,
        nextState: state,
        workingMs: now - s.since,
        minWorkingMs: (this.cfg.minWorkingSeconds ?? 60) * 1000,
      });
      s.state = state;
      s.since = now;
      s.confirm = 0;
      if (n) await this.send(name, n);
    }
  }

  async send(name, n) {
    const link = this.baseUrl ? `\n${this.baseUrl}/#/t/${encodeURIComponent(name)}` : '';
    const text = `tapmux · ${name}\n${n.text}${link}`;
    const args = ['-s', '--connect-timeout', '10', '--max-time', '20'];
    if (this.cfg.proxyUrl) args.push('-x', this.cfg.proxyUrl);
    args.push(
      `https://api.telegram.org/bot${this.cfg.telegramBotToken}/sendMessage`,
      '--data-urlencode', `chat_id=${this.cfg.telegramChatId}`,
      '--data-urlencode', `text=${text}`,
      '-d', 'disable_web_page_preview=true',
    );
    await new Promise((resolve) => {
      execFile('curl', args, (err, stdout) => {
        if (err || !String(stdout).includes('"ok":true')) {
          this.log.error(`[tapmux] 通知发送失败(${name}):`, err ? err.message : String(stdout).slice(0, 120));
        } else {
          this.log.log(`[tapmux] 已通知 ${name}: ${n.kind}`);
        }
        resolve();
      });
    });
  }
}
