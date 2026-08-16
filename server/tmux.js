import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import crypto from 'node:crypto';

const SEP = '\u001f';

export function validSessionName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,49}$/.test(name);
}

function tmux(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('tmux', args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

function noServer(err) {
  const s = `${err.stderr || ''}${err.message || ''}`;
  return /no server running|No such file or directory|error connecting/i.test(s);
}

export async function listSessions() {
  try {
    const out = await tmux(['list-sessions', '-F',
      `#{session_name}${SEP}#{session_created}${SEP}#{session_windows}${SEP}#{session_attached}`]);
    return out.trim().split('\n').filter(Boolean).map((line) => {
      const [name, created, windows, attached] = line.split(SEP);
      return { name, created: Number(created) * 1000, windows: Number(windows), attached: Number(attached) };
    });
  } catch (err) {
    if (noServer(err)) return [];
    throw err;
  }
}

// 每个会话各 pane 的前台命令,用于标记"这里在跑 claude"
export async function paneCommands() {
  try {
    const out = await tmux(['list-panes', '-a', '-F', `#{session_name}${SEP}#{pane_current_command}`]);
    const map = new Map();
    for (const line of out.trim().split('\n').filter(Boolean)) {
      const [name, cmd] = line.split(SEP);
      if (!map.has(name)) map.set(name, []);
      if (cmd && !map.get(name).includes(cmd)) map.get(name).push(cmd);
    }
    return map;
  } catch (err) {
    if (noServer(err)) return new Map();
    throw err;
  }
}

export async function hasSession(name) {
  try {
    await tmux(['has-session', '-t', `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

// 备用屏必须关:Claude Code 等全屏应用的输出才会进 tmux 历史,滚轮才有东西可滚。
// 注意:若 pane 已被"选项开启时启动的应用"带进备用屏,会永久锁死在里面(rmcup 也被忽略),
// 只能重建会话——所以创建时就设,不给锁死的机会。
export async function setAlternateScreenOff(name) {
  await tmux(['set-option', '-w', '-t', `=${name}:`, 'alternate-screen', 'off']);
}

export async function createSession(name, { command } = {}) {
  await tmux(['new-session', '-d', '-s', name, '-c', os.homedir()]);
  await setAlternateScreenOff(name);
  if (command) {
    await sendText(name, command, { enter: true });
  }
}

export async function killSession(name) {
  await tmux(['kill-session', '-t', `=${name}`]);
}

// 整段注入文本:load-buffer + paste-buffer(-p 尊重应用的括号粘贴模式)。
// 可靠处理中文/多行/特殊字符,绕开逐键序列的一切坑。
export async function sendText(name, text, { enter = false } = {}) {
  const buf = `palmux-${crypto.randomBytes(4).toString('hex')}`;
  await tmux(['load-buffer', '-b', buf, '-'], { input: text });
  await tmux(['paste-buffer', '-p', '-d', '-b', buf, '-t', `=${name}:`]);
  if (enter) {
    await tmux(['send-keys', '-t', `=${name}:`, 'Enter']);
  }
}

// 特殊键经 tmux 翻译(tmux 知道 pane 处于何种键盘模式),白名单限定
const KEY_ALLOW = new Set([
  'Up', 'Down', 'Left', 'Right', 'Escape', 'Tab', 'Enter', 'BSpace',
  'PageUp', 'PageDown', 'Home', 'End', 'C-c', 'C-d', 'C-u', 'C-r', 'C-l',
]);

export function validKeys(keys) {
  return Array.isArray(keys) && keys.length > 0 && keys.length <= 5 && keys.every((k) => KEY_ALLOW.has(k));
}

export async function sendKeys(name, keys) {
  await tmux(['send-keys', '-t', `=${name}:`, ...keys]);
}

// 进入回滚(copy-mode),之后触屏滚动/方向键即可翻历史,Esc 退出
export async function enterCopyMode(name) {
  await tmux(['copy-mode', '-e', '-t', `=${name}:`]);
}

// 侧边滚轮:不依赖浏览器滚轮事件,直接驱动 tmux 滚动。
// 不在 copy-mode 时向上滚自动进入;-e 保证滚回底部自动退出回实时。
export async function scrollPane(name, dir) {
  const target = `=${name}:`;
  const inMode = (await tmux(['display-message', '-p', '-t', target, '#{pane_in_mode}'])).trim() === '1';
  if (!inMode) {
    if (dir === 'down') return; // 本就在实时底部
    await tmux(['copy-mode', '-e', '-t', target]);
  }
  await tmux(['send-keys', '-t', target, '-N', '5', '-X', dir === 'up' ? 'scroll-up' : 'scroll-down']);
}

// 探测按钮的另一半:抓取会话当前屏幕文本(预览用,可选功能)
export async function capturePane(name) {
  return tmux(['capture-pane', '-p', '-t', `=${name}:`]);
}

export function spawnAttach(ptyLib, name, { cols, rows }) {
  return ptyLib.spawn('tmux', ['attach-session', '-t', `=${name}`], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });
}

export { spawn };
