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

// pane 是否处于 copy-mode 等模式(回滚看历史时)
async function paneInMode(name) {
  return (await tmux(['display-message', '-p', '-t', `=${name}:`, '#{pane_in_mode}'])).trim() === '1';
}

// 退出 copy-mode 回到实时画面。回滚看完历史没滚回底部时 pane 仍在 copy-mode:
// paste-buffer 直写 pane,文字能进应用,但 send-keys 的 Enter 会被 copy-mode 吃掉
// (emacs 键表里 Enter 无绑定),而且屏幕冻在历史视图上——手机端看起来就是
// "点了发送没反应,按一下 Esc 才显示出来"。所以任何要送进应用的输入先退模式。
export async function exitMode(name) {
  if (await paneInMode(name)) {
    await tmux(['send-keys', '-t', `=${name}:`, '-X', 'cancel']);
  }
}

// 整段注入文本:load-buffer + paste-buffer(-p 尊重应用的括号粘贴模式)。
// 可靠处理中文/多行/特殊字符,绕开逐键序列的一切坑。
export async function sendText(name, text, { enter = false } = {}) {
  await exitMode(name);
  const buf = `tapmux-${crypto.randomBytes(4).toString('hex')}`;
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

// 这些键在 copy-mode 里有意义(翻历史/退出),原样交给 copy-mode;其余键(Enter/Tab/^C…)
// 是给应用的,pane 在 copy-mode 时先退出再送,否则被模式吞掉
const MODE_NAV_KEYS = new Set(['Up', 'Down', 'Left', 'Right', 'PageUp', 'PageDown', 'Home', 'End', 'Escape']);

export function keysNeedLiveMode(keys) {
  return keys.some((k) => !MODE_NAV_KEYS.has(k));
}

export async function sendKeys(name, keys) {
  if (keysNeedLiveMode(keys)) await exitMode(name);
  await tmux(['send-keys', '-t', `=${name}:`, ...keys]);
}

// pane 现状一次取齐:是否在 copy-mode 等模式、应用是否接管鼠标、前台命令、终端、高度
async function paneInfo(name) {
  const out = await tmux(['display-message', '-p', '-t', `=${name}:`,
    ['#{pane_in_mode}', '#{mouse_any_flag}#{mouse_all_flag}#{mouse_button_flag}#{mouse_standard_flag}',
      '#{pane_current_command}', '#{pane_tty}', '#{pane_height}'].join(SEP)]);
  const [mode, mouse, cmd, tty, height] = out.trim().split(SEP);
  return { inMode: mode === '1', mouse: /1/.test(mouse), cmd, tty, height: Number(height) || 24 };
}

// ps 参数行是不是 codex:原生二进制(…/bin/codex)或 npm 版的 node 包装(node /usr/bin/codex)
export function isCodexArgs(line) {
  const [a0 = '', a1 = ''] = String(line).trim().split(/\s+/);
  const codex = (a) => /(^|\/)codex$/.test(a);
  return codex(a0) || (/(^|\/)node$/.test(a0) && codex(a1));
}

// pane 里跑的是不是 codex。npm 版经 node 包装启动,前台命令名是 node,要看该终端上的进程参数
async function paneIsCodex(info) {
  if (info.cmd === 'codex') return true;
  if (info.cmd !== 'node' || !info.tty) return false;
  return new Promise((resolve) => {
    execFile('ps', ['-t', info.tty.replace(/^\/dev\//, ''), '-o', 'args='], (err, stdout) => {
      resolve(!err && String(stdout).split('\n').some(isCodexArgs));
    });
  });
}

// codex 只认 PgUp/PgDn 整页翻:把触屏走过的行数按会话累积,攒够 pageRows 行才翻一页;
// 停手 1.5 秒或换方向就清零,免得上一次滑动的零头带进下一次
export function makePager(idleMs = 1500) {
  const acc = new Map();
  return (key, dir, rows, pageRows, now = Date.now()) => {
    let st = acc.get(key);
    if (!st || st.dir !== dir || now - st.at > idleMs) st = { dir, rows: 0 };
    st.rows += rows;
    st.at = now;
    const pages = Math.floor(st.rows / pageRows);
    st.rows -= pages * pageRows;
    acc.set(key, st);
    return pages;
  };
}
const codexPager = makePager();

// 进入回滚,之后触屏滚动/方向键即可翻历史,Esc 退出。
// 应用自己管滚动时(Claude Code、codex)tmux 历史里没东西可翻,改为让应用翻一页(PageUp)。
export async function enterCopyMode(name) {
  const info = await paneInfo(name);
  if (!info.inMode && (info.mouse || (await paneIsCodex(info)))) {
    await tmux(['send-keys', '-t', `=${name}:`, 'PageUp']);
    return;
  }
  await tmux(['copy-mode', '-e', '-t', `=${name}:`]);
}

// SGR 鼠标滚轮报文(64=上滚 65=下滚),坐标随便给个 pane 内的点
export function wheelReports(dir, n) {
  return `\u001b[<${dir === 'up' ? 64 : 65};2;2M`.repeat(n);
}

// 滚动行数:缺省 5(侧栏点一下);触屏/滚轮按手指走过的行数传,封顶 50
export function scrollLines(v) {
  return Number.isInteger(v) ? Math.min(Math.max(v, 1), 50) : 5;
}

// 服务端驱动滚动(侧栏 ▲▼,以及不接管鼠标的应用的触屏滑动/滚轮)。fine = 按行数精细滚(触屏/滚轮)。
// - 应用接管鼠标(Claude Code 2.1+,回复在应用内虚拟滚动、不进 tmux 历史):喂滚轮报文
// - codex:不接管鼠标,也不把旧内容留在 tmux 历史里(原地重绘),只认 PgUp/PgDn 翻它自己的记录。
//   侧栏点一下翻一页;触屏攒够半屏翻一页
// - 其余:tmux copy-mode,不在时向上滚自动进入;-e 保证滚回底部自动退出回实时
export async function scrollPane(name, dir, lines = 5, { fine = false } = {}) {
  const target = `=${name}:`;
  const info = await paneInfo(name);
  if (!info.inMode && info.mouse) {
    // Claude Code 两个报文滚一行,连发有加速:实测 6 个 ≈ 5-7 行,与 copy-mode 的 -N 5 手感一致
    await tmux(['send-keys', '-t', target, '-l', wheelReports(dir, fine ? lines * 2 : 6)]);
    return;
  }
  if (!info.inMode && (await paneIsCodex(info))) {
    const pages = fine ? codexPager(name, dir, lines, Math.max(4, Math.floor(info.height / 2))) : 1;
    if (pages) await tmux(['send-keys', '-t', target, ...Array(pages).fill(dir === 'up' ? 'PageUp' : 'PageDown')]);
    return;
  }
  if (!info.inMode) {
    if (dir === 'down') return; // 本就在实时底部
    await tmux(['copy-mode', '-e', '-t', target]);
  }
  await tmux(['send-keys', '-t', target, '-N', String(lines), '-X', dir === 'up' ? 'scroll-up' : 'scroll-down']);
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
