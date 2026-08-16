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
  constructor(config, { probe, capture, detect, fingerprint, log = console }) {
    this.fingerprint = fingerprint;
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
    const text = await this.capture(name);
    let state = this.detect(text);
    const now = Date.now();
    // 画面在动 = 在干活:UI 文案会变,"正文两拍不同"这个机制不会
    const fp = this.fingerprint ? this.fingerprint(text) : null;
    const prevFp = this.sessions.get(name)?.fp;
    if (fp !== null) {
      const cur0 = this.sessions.get(name);
      if (cur0) cur0.fp = fp;
      if (state === 'idle' && prevFp !== undefined && fp !== prevFp) state = 'working';
    }
    if (this.cfg.debug) {
      const cur = this.sessions.get(name);
      const spin = text.split('\n').find((l) => /…/.test(l)) || '';
      this.log.log(`[tapmux][notify-debug] ${name} 看到=${state} 文长=${text.length} 旋转行=${JSON.stringify(spin.slice(0, 60))} 已确认=${cur?.state ?? '首见'}`);
    }
    let s = this.sessions.get(name);
    if (!s) {
      // 首见:静默登记,不为存量状态发通知
      this.sessions.set(name, { state, since: now, pending: state, pendingSince: now, confirm: 0, fp });
      return;
    }
    if (state !== s.pending) {
      s.pending = state;
      s.pendingSince = now; // 新状态首见时刻:时长从这里起算,消除确认延迟的计量损耗
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
        workingMs: s.pendingSince - s.since,
        minWorkingMs: (this.cfg.minWorkingSeconds ?? 30) * 1000,
      });
      s.state = state;
      s.since = s.pendingSince;
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
