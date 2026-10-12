// tapmux ctl:agent / 脚本操作纳管会话的命令行客户端(调本机或经 relay 的 agent 接口)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const USAGE = `用法: tapmux ctl <子命令> [参数] [选项]

  ls                              列出纳管会话:名字 / 状态 / 模型
  screen <会话> [-n 40]            看会话当前屏幕(纯文本)+ 排队 + 最近操作
  send <会话> <文本…>              往会话里下一条指令(斜杠指令或一句话)
  model <会话> <模型>              切模型,默认只改这个会话
                                  模型: fable / opus / sonnet / haiku(该家族最新)、"fable 5.1"、claude-fable-5-1、default
  macro <会话> <宏名或 id>          立刻执行一条已配置的宏
  keys <会话> <键…>                发特殊键:Escape Enter Tab C-c Up Down …
  queue <会话> [--cancel <id>]      看/取消排队中的指令

  <会话> 写 . 表示当前所在的 tmux 会话

选项:
  --wait <秒>   会话在忙时最多等这么久(默认 0:忙就报 busy)
  --queue       会话在忙就排队,等它空闲再执行;目标是自己所在的会话时自动开启
  --force       跳过「空闲且没人打字」安全门
  --confirm     发出后若弹确认框,自动补回车
  --no-enter    只填进输入框,不回车
  --persist     切模型时同时存为全机新会话的默认模型
  --json        输出原始 JSON

连接: 默认读 ~/.config/tapmux/config.json 连本机。
      远程直连: TAPMUX_URL=http://主机:7802 TAPMUX_TOKEN=<token>
      经 relay: TAPMUX_URL=https://<relay>/d/<设备名> TAPMUX_USER_TOKEN=<用户 token>
退出码: 0 成功/已排队  1 失败  2 会话在忙`;

function parseArgs(argv) {
  const flags = { wait: 0, n: 40 };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wait') flags.wait = Number(argv[++i]) || 0;
    else if (a === '-n' || a === '--lines') flags.n = Number(argv[++i]) || 40;
    else if (a === '--cancel') flags.cancel = argv[++i];
    else if (a === '--queue') flags.queue = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--confirm') flags.confirm = true;
    else if (a === '--no-enter') flags.noEnter = true;
    else if (a === '--persist') flags.persist = true;
    else if (a === '--json') flags.json = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else pos.push(a);
  }
  return { flags, pos };
}

function connection() {
  if (process.env.TAPMUX_URL) {
    const base = process.env.TAPMUX_URL.replace(/\/$/, '');
    const headers = {};
    if (process.env.TAPMUX_TOKEN) headers.authorization = `Bearer ${process.env.TAPMUX_TOKEN}`;
    if (process.env.TAPMUX_USER_TOKEN) headers.cookie = `tapmux_user=${process.env.TAPMUX_USER_TOKEN}`;
    return { base, headers };
  }
  // 只读配置,不走 loadConfig(那个会回写文件、建目录)
  const file = path.join(os.homedir(), '.config', 'tapmux', 'config.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`读不到 ${file};本机没装 tapmux 就用 TAPMUX_URL + TAPMUX_TOKEN 连远程`);
  }
  return { base: `http://127.0.0.1:${cfg.port || 7802}`, headers: { authorization: `Bearer ${cfg.token}` } };
}

// 当前所在的 tmux 会话(agent 在 Claude Code 里跑 Bash 时继承 TMUX_PANE)
function currentSession() {
  if (!process.env.TMUX_PANE) return null;
  try {
    return execFileSync('tmux', ['display-message', '-p', '-t', process.env.TMUX_PANE, '#S'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

async function call(conn, method, p, body) {
  const res = await fetch(conn.base + p, {
    method,
    headers: { ...conn.headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { error: `HTTP ${res.status}` };
  }
  return { status: res.status, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 会话忙时按 --wait 分段重试:服务端单次最多等 15s(relay 的 HTTP 流 30s 断)
async function act(conn, p, body, flags) {
  const deadline = Date.now() + Math.max(flags.wait, 0) * 1000;
  for (;;) {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    const r = await call(conn, 'POST', p, { ...body, waitSec: Math.min(Math.max(left, 0), 15) });
    if (r.status !== 409 || Date.now() >= deadline) return r;
    await sleep(500);
  }
}

function tail(screen, n = 8) {
  return String(screen || '').split('\n').filter((l) => l.trim()).slice(-n).join('\n');
}

function report(r, flags, okText) {
  if (flags.json) {
    console.log(JSON.stringify(r.data, null, 2));
  } else if (r.status === 202) {
    const when = flags.selfQueue ? '目标就是当前所在会话,本轮回复结束后自动执行' : '会话在忙,空闲后自动执行';
    console.log(`⏳ 已排队(id ${r.data.queued},第 ${r.data.position} 位):${when}`);
  } else if (r.status === 409) {
    const why = r.data.inputBusy ? '输入框里有人在打字' : { working: 'Claude 正在干活', waiting: 'Claude 在等人确认' }[r.data.state] || r.data.state;
    console.log(`⏸ 会话在忙(${why}),没发。可加 --wait 秒 或 --queue`);
  } else if (r.data.ok) {
    console.log(okText(r.data));
    if (r.data.note) console.log(`  注意: ${r.data.note}`);
    if (r.data.screen) console.log(`--- 屏幕末尾 ---\n${tail(r.data.screen)}`);
  } else {
    console.log(`✗ ${r.data.error || `HTTP ${r.status}`}`);
    if (r.data.available) console.log(`  可选: ${r.data.available.join(' / ')}`);
  }
  if (r.status === 202) return 0;
  if (r.status === 409) return 2;
  return r.data.ok ? 0 : 1;
}

export async function main(argv) {
  const { flags, pos } = parseArgs(argv);
  const [sub, rawName, ...rest] = pos;
  if (!sub || flags.help || sub === 'help') {
    console.log(USAGE);
    return sub || flags.help ? 0 : 1;
  }
  const conn = connection();
  const here = currentSession();
  const name = rawName === '.' ? here : rawName;
  if (rawName === '.' && !name) throw new Error('不在 tmux 里,不能用 . 指代当前会话');
  const enc = name ? encodeURIComponent(name) : '';
  // 给自己所在的会话下指令:此刻它必然在忙(正跑着这条命令),直接排队到本轮结束
  const selfQueue = !flags.force && name && name === here;
  const queue = flags.queue || selfQueue || undefined;
  flags.selfQueue = selfQueue;

  if (sub === 'ls') {
    const r = await call(conn, 'GET', '/api/sessions');
    if (flags.json || r.status !== 200) { console.log(JSON.stringify(r.data, null, 2)); return r.status === 200 ? 0 : 1; }
    const st = { idle: '空闲', working: '干活中', waiting: '等确认' };
    for (const s of r.data.managed) {
      console.log([s.name.padEnd(14), (st[s.state] || '-').padEnd(4), s.model || '-', s.name === here ? '← 当前' : ''].join('  ').trimEnd());
    }
    if (r.data.wild.length) console.log(`(未纳管: ${r.data.wild.map((s) => s.name).join(' ')})`);
    return 0;
  }

  if (!name) throw new Error('缺会话名');

  if (sub === 'screen') {
    const r = await call(conn, 'GET', `/api/sessions/${enc}/screen?lines=${flags.n}`);
    if (flags.json || r.status !== 200) { console.log(JSON.stringify(r.data, null, 2)); return r.status === 200 ? 0 : 1; }
    const d = r.data;
    console.log(`# ${d.name} · ${d.claude ? `Claude ${d.state}${d.model ? ` · ${d.model}` : ''}` : '非 Claude 会话'}${d.inputBusy ? ' · 输入框有字' : ''}`);
    console.log(d.screen);
    if (d.queue.length) console.log(`# 排队: ${d.queue.map((q) => `${q.id} ${q.action.model ? `模型→${q.action.model}` : q.action.text}`).join(' | ')}`);
    if (d.recent.length) {
      const x = d.recent[d.recent.length - 1];
      console.log(`# 最近: ${new Date(x.at).toLocaleTimeString()} ${x.source} ${x.action.model ? `模型→${x.action.model}` : x.action.text} → ${x.ok ? 'ok' : x.detail}`);
    }
    return 0;
  }

  if (sub === 'send') {
    const text = rest.join(' ');
    if (!text) throw new Error('缺指令文本');
    const r = await act(conn, `/api/sessions/${enc}/command`, {
      text, enter: !flags.noEnter, confirm: flags.confirm, persist: flags.persist, force: flags.force, queue,
    }, flags);
    return report(r, flags, (d) => (d.model ? `✓ ${name} 已切到 ${d.model}(${d.scope === 'session' ? '仅本会话' : '已存为默认'})` : `✓ 已发给 ${name}${d.confirmed ? ',并补了确认' : ''};现在 ${d.state}`));
  }

  if (sub === 'model') {
    const model = rest.join(' ');
    if (!model) throw new Error('缺模型名');
    const r = await act(conn, `/api/sessions/${enc}/model`, { model, persist: flags.persist, force: flags.force, queue }, flags);
    return report(r, flags, (d) => `✓ ${name} 已切到 ${d.model}(${d.scope === 'session' ? '仅本会话' : '已存为默认'})`);
  }

  if (sub === 'macro') {
    if (!rest.length) throw new Error('缺宏名或 id');
    const r = await act(conn, `/api/sessions/${enc}/macros/${encodeURIComponent(rest.join(' '))}/run`, { force: flags.force, queue }, flags);
    return report(r, flags, (d) => `✓ 宏已执行;现在 ${d.state}`);
  }

  if (sub === 'keys') {
    if (!rest.length) throw new Error('缺按键');
    const r = await call(conn, 'POST', `/api/sessions/${enc}/send`, { keys: rest });
    return report(r, flags, () => `✓ 已按 ${rest.join(' ')}`);
  }

  if (sub === 'queue') {
    if (flags.cancel) {
      const r = await call(conn, 'DELETE', `/api/sessions/${enc}/queue/${encodeURIComponent(flags.cancel)}`);
      return report(r, flags, () => `✓ 已取消 ${flags.cancel}`);
    }
    const r = await call(conn, 'GET', `/api/sessions/${enc}/screen?lines=1`);
    if (r.status !== 200) { console.log(JSON.stringify(r.data)); return 1; }
    if (flags.json) { console.log(JSON.stringify(r.data.queue, null, 2)); return 0; }
    if (!r.data.queue.length) console.log('(没有排队项)');
    for (const q of r.data.queue) {
      console.log(`${q.id}  ${q.action.model ? `模型→${q.action.model}` : q.action.text}  (${Math.round((Date.now() - q.addedAt) / 1000)}s 前)`);
    }
    return 0;
  }

  console.log(USAGE);
  return 1;
}
