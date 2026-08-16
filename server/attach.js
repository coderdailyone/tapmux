import * as ptyLib from '@lydell/node-pty';
import { spawnAttach } from './tmux.js';

const HIGH_WATER = 2 * 1024 * 1024;
const LOW_WATER = 256 * 1024;
const HEARTBEAT_MS = 30_000;

// 一条 WS 连接 = 一个 tmux attach 客户端。tmux 是唯一状态层:
// 断线重连时 tmux 全屏重绘,这里不需要任何补发逻辑。
export function handleAttach(ws, name, { cols, rows }) {
  let pty;
  try {
    pty = spawnAttach(ptyLib, name, { cols, rows });
  } catch (err) {
    ws.close(1011, 'spawn failed');
    return;
  }

  let alive = true;
  let exited = false; // pty 死后任何 write/resize 都可能抛,必须挡住
  const canPause = typeof pty.pause === 'function' && typeof pty.resume === 'function';
  let paused = false;
  let drainTimer = null;

  const dataSub = pty.onData((data) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(Buffer.from(data, 'utf8'), { binary: true });
    // 背压:浏览器消费不过来时暂停读 pty,tmux 自身会向上游节流
    if (canPause && !paused && ws.bufferedAmount > HIGH_WATER) {
      paused = true;
      pty.pause();
      drainTimer = setInterval(() => {
        if (ws.bufferedAmount < LOW_WATER || ws.readyState !== ws.OPEN) {
          clearInterval(drainTimer);
          drainTimer = null;
          paused = false;
          if (ws.readyState === ws.OPEN) pty.resume();
        }
      }, 50);
    }
  });

  const exitSub = pty.onExit(() => {
    exited = true;
    if (ws.readyState === ws.OPEN) ws.close(1000, 'detached');
  });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      if (msg.t === 'input' && typeof msg.data === 'string') {
        if (!exited) pty.write(msg.data);
      } else if (msg.t === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
        const c = Math.min(Math.max(msg.cols, 10), 500);
        const r = Math.min(Math.max(msg.rows, 4), 300);
        if (!exited) pty.resize(c, r);
      } else if (msg.t === 'ping') {
        ws.send(JSON.stringify({ t: 'pong' }));
      }
    } catch (err) {
      // pty 竞态死亡时的 write/resize 异常:关此连接即可,绝不许波及进程
      console.error(`[tapmux] pty op failed on ${name}:`, err.message);
      try { ws.close(1011, 'pty gone'); } catch {}
    }
  });

  ws.on('error', (err) => {
    console.error(`[tapmux] ws error on ${name}:`, err.message);
    try { ws.terminate(); } catch {}
  });

  ws.on('pong', () => {
    alive = true;
  });
  const hb = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, HEARTBEAT_MS);

  ws.on('close', () => {
    clearInterval(hb);
    if (drainTimer) clearInterval(drainTimer);
    dataSub.dispose();
    exitSub.dispose();
    try {
      pty.kill();
    } catch {}
  });
}
