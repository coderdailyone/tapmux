import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validSessionName, validKeys, keysNeedLiveMode, wheelReports, scrollLines, isCodexArgs, makePager } from '../server/tmux.js';
import { tokensEqual, parseCookies } from '../server/auth.js';
import { extForMime, saveImage, resolveServable, cleanupOldUploads } from '../server/uploads.js';
import { previewFromCapture, detectClaudeState, contentFingerprint } from '../server/preview.js';

test('内容指纹:时钟/状态条自变不改指纹,正文变则变', () => {
  const a = '正文一样\n  [Fable 5] │ user │ ⏱️ 24m\n  Usage ██ 5% (resets in 4h 12m)\n✽ Skedaddling… (3s · ↓ 88 tokens)';
  const b = '正文一样\n  [Fable 5] │ user │ ⏱️ 25m\n  Usage ██ 6% (resets in 4h 11m)\n· Scampering…';
  assert.equal(contentFingerprint(a), contentFingerprint(b));
  const c = '正文多了一行\n正文一样\n  [Fable 5] │ user │ ⏱️ 25m';
  assert.notEqual(contentFingerprint(a), contentFingerprint(c));
});
import { decideNotification } from '../server/notify.js';
import { validateMacros, shouldFire, inputBusy } from '../server/macros.js';

test('会话宏:触发判定/冷却/输入占用/校验', () => {
  const now = 1_000_000_000;
  const pin = { trigger: { type: 'missing', pattern: '\\[Fable 5\\]' }, cooldownSec: 300, action: { text: '/model x' } };
  assert.ok(shouldFire(pin, '状态条 [Sonnet] 别的', now), '降级(字样缺失)应触发');
  assert.ok(!shouldFire(pin, '状态条 [Fable 5] 正常', now), '未降级不触发');
  assert.ok(!shouldFire({ ...pin, lastFiredAt: now - 100_000 }, '[Sonnet]', now), '冷却期内不重发');
  assert.ok(shouldFire({ ...pin, lastFiredAt: now - 301_000 }, '[Sonnet]', now), '冷却过后可再发');
  const iv = { trigger: { type: 'interval', everySec: 600 }, cooldownSec: 60, action: { text: 'x' } };
  assert.ok(shouldFire({ ...iv, lastFiredAt: now - 601_000 }, '', now));
  assert.ok(!shouldFire({ ...iv, lastFiredAt: now - 100_000 }, '', now));
  assert.ok(shouldFire({ trigger: { type: 'present', pattern: 'ERROR' }, cooldownSec: 60, action: { text: 'x' } }, '有 ERROR 出现', now));

  assert.ok(inputBusy('❯ 我打了一半的话'), '输入框有内容=占用');
  assert.ok(!inputBusy('❯ \n别的行'), '空输入框=不占用');
  assert.ok(!inputBusy('❯ Try "create a util logging.py that..."'), 'claude 占位提示=不占用(真机抓的坑)');

  assert.equal(validateMacros([{ id: 'a', name: '钉', trigger: { type: 'missing', pattern: 'x' }, action: { text: '/m' } }]), null);
  assert.ok(validateMacros([{ id: 'a', name: '钉', trigger: { type: 'missing', pattern: '(' }, action: { text: 'x' } }]), '烂正则拒绝');
  assert.ok(validateMacros([{ id: 'a', name: '钉', trigger: { type: 'interval', everySec: 5 }, action: { text: 'x' } }]), '间隔过短拒绝');
  assert.ok(validateMacros(Array(9).fill({ name: 'x', trigger: { type: 'interval', everySec: 60 }, action: { text: 'x' } })), '数量超限拒绝');
});
import { T, encode, decode, encodeJson, parseJson, cleanHeaders } from '../server/relay/protocol.js';
import { Registry } from '../server/relay/registry.js';

test('relay 协议:帧编解码往返 + 头清洗', () => {
  const f = decode(encode(T.RES_BODY, 42, Buffer.from('数据')));
  assert.equal(f.type, T.RES_BODY);
  assert.equal(f.sid, 42);
  assert.equal(f.payload.toString(), '数据');
  const j = decode(encodeJson(T.REQ, 7, { method: 'GET', path: '/x' }));
  assert.deepEqual(parseJson(j.payload), { method: 'GET', path: '/x' });
  assert.equal(decode(Buffer.alloc(3)), null);
  const h = cleanHeaders({ Cookie: 'a=1', Connection: 'keep-alive', Host: 'x', 'content-type': 'json' });
  assert.deepEqual(h, { Cookie: 'a=1', 'content-type': 'json' });
});

test('relay 用户体系:一人一 token,机器挂人名下,邀请码带归属', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapmux-usr-'));
  const reg = new Registry(dir);
  const u = reg.createUser('zhang');
  assert.ok(u.userToken);
  assert.equal(reg.authUser(u.userToken), 'zhang');
  assert.equal(reg.authUser('bad'), null);
  assert.ok(reg.createUser('zhang').error, '重名拒绝');
  assert.ok(reg.createInvite('nobody').error, '给不存在的用户发码拒绝');
  const { code } = reg.createInvite('zhang');
  const d = reg.register(code, 'box-1');
  assert.equal(reg.ownerOf('box-1'), 'zhang', '经邀请码注册自动归属');
  assert.ok(!JSON.stringify(reg.data).includes(u.userToken), '用户 token 明文不落盘');
  assert.deepEqual(reg.listUsers()[0].devices, ['box-1']);
  const u2 = reg.createUser('li');
  assert.ok(reg.claimDevice('box-1', 'li'));
  assert.equal(reg.ownerOf('box-1'), 'li');
  assert.ok(reg.revokeUser('zhang'));
  assert.equal(reg.authUser(u.userToken), null);
  assert.ok(d.deviceToken && u2.userToken);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('relay 注册表:邀请码单次有效,token 只存哈希,可吊销', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapmux-reg-'));
  const reg = new Registry(dir);
  reg.createUser('u');
  const { code } = reg.createInvite('u');
  assert.ok(reg.register('wrong', 'a').error);
  const r = reg.register(code, 'home-1');
  assert.equal(r.name, 'home-1');
  assert.ok(reg.register(code, 'other').error, '同码二次使用必须失败');
  assert.ok(reg.auth('home-1', r.deviceToken));
  assert.ok(!reg.auth('home-1', 'bad'));
  assert.ok(!JSON.stringify(reg.data).includes(r.deviceToken), '明文 token 不落盘');
  assert.ok(reg.register(reg.createInvite('u').code, 'Home!').error, '非法设备名拒绝');
  assert.ok(reg.revoke('home-1'));
  assert.ok(!reg.auth('home-1', r.deviceToken));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('通知决策:等确认必发,完工须干满时长,其余不扰', () => {
  const min = { minWorkingMs: 60_000 };
  assert.equal(decideNotification({ prevState: 'working', nextState: 'waiting', workingMs: 5000, ...min }).kind, 'waiting');
  assert.equal(decideNotification({ prevState: 'working', nextState: 'idle', workingMs: 90_000, ...min }).kind, 'done');
  assert.equal(decideNotification({ prevState: 'working', nextState: 'idle', workingMs: 20_000, ...min }), null);
  assert.equal(decideNotification({ prevState: 'idle', nextState: 'working', workingMs: 0, ...min }), null);
  assert.equal(decideNotification({ prevState: 'idle', nextState: 'waiting', workingMs: 0, ...min }).kind, 'waiting');
  assert.equal(decideNotification({ prevState: 'waiting', nextState: 'idle', workingMs: 0, ...min }), null);
});

test('Claude 状态感知:等确认 > 干活中 > 空闲', () => {
  assert.equal(detectClaudeState('✻ Crunching… (esc to interrupt)'), 'working');
  assert.equal(detectClaudeState('✻ Brewed for 46s\n  tokens · esc to interrupt'), 'working');
  // 新版旋转器形态(真机 2026-08 抓取)
  assert.equal(detectClaudeState('✽ Skedaddling… (3s · ↓ 88 tokens)'), 'working');
  assert.equal(detectClaudeState('✻ Reticulating… (2m 14s · ↑ 1.2k tokens)'), 'working');
  // 完工残留行绝不能误判为干活中
  assert.equal(detectClaudeState('✻ Churned for 30s\n❯ '), 'idle');
  assert.equal(detectClaudeState('Do you want to create test.txt?\n❯ 1. Yes\n  2. No'), 'waiting');
  assert.equal(detectClaudeState('   Enter to confirm · Esc to cancel'), 'waiting');
  // 对话框与旋转器同屏时,等确认优先
  assert.equal(detectClaudeState('esc to interrupt\n❯ 1. Yes'), 'waiting');
  assert.equal(detectClaudeState('❯ \n  普通输入框空闲'), 'idle');
});

test('会话名校验:放行常规,拒绝注入形状', () => {
  assert.ok(validSessionName('cc'));
  assert.ok(validSessionName('my-work_1.x'));
  assert.ok(!validSessionName(''));
  assert.ok(!validSessionName('-t'));           // 不许杠开头,防被当参数
  assert.ok(!validSessionName('a b'));
  assert.ok(!validSessionName('a;rm'));
  assert.ok(!validSessionName('中文'));
  assert.ok(!validSessionName('x'.repeat(51)));
  assert.ok(!validSessionName(null));
});

test('按键白名单:只放行声明过的键', () => {
  assert.ok(validKeys(['Up']));
  assert.ok(validKeys(['C-c', 'Enter']));
  assert.ok(!validKeys([]));
  assert.ok(!validKeys(['rm -rf']));
  assert.ok(!validKeys(['Up', 'EvilKey']));
  assert.ok(!validKeys('Up'));
  assert.ok(!validKeys(Array(6).fill('Up')));
});

test('token 比较:恒时比较且拒绝非串', () => {
  assert.ok(tokensEqual('abc', 'abc'));
  assert.ok(!tokensEqual('abc', 'abd'));
  assert.ok(!tokensEqual('abc', undefined));
  assert.ok(!tokensEqual(undefined, undefined));
});

test('cookie 解析', () => {
  assert.deepEqual(parseCookies('a=1; tapmux_token=xyz'), { a: '1', tapmux_token: 'xyz' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('MIME 白名单', () => {
  assert.equal(extForMime('image/jpeg'), 'jpg');
  assert.equal(extForMime('image/png; charset=x'), 'png');
  assert.equal(extForMime('text/html'), null);
  assert.equal(extForMime(undefined), null);
});

test('卡片预览:滤 Claude UI 噪音,留正文末行,超长截断', () => {
  const screen = [
    '  正文第一行',
    '─────────────────',
    '❯ ',
    '  ⏵⏵ bypass permissions on (shift+tab',
    '  [Fable 5] │ user',
    '  Context ░░░ 3%',
    '  Usage   ██░ 47% (resets in 45m)',
    '✻ Crunched for 3s',
    '❯ 输入中的半截话',
    '  正文第二行',
    '  正文第三行',
    '',
  ].join('\n');
  assert.deepEqual(previewFromCapture(screen), ['正文第二行', '正文第三行']);
  assert.deepEqual(previewFromCapture(''), []);
  const long = previewFromCapture(`x`.repeat(100));
  assert.equal(long[0].length, 64);
  assert.ok(long[0].endsWith('…'));
});

test('上传落盘 + 只读回自己的目录 + 过期清理', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapmux-test-'));
  const saved = saveImage(dir, Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
  assert.ok(saved.path.startsWith(dir));
  assert.match(saved.url, /^\/uploads\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{12}\.jpg$/);

  // 合法 url 可解析回文件
  assert.equal(resolveServable(dir, saved.url), saved.path);
  // 穿越/乱形状一律 null
  assert.equal(resolveServable(dir, '/uploads/../etc/passwd'), null);
  assert.equal(resolveServable(dir, '/uploads/2026-08-15/../../x.jpg'), null);
  assert.equal(resolveServable(dir, '/uploads/2026-08-15/zz.sh'), null);

  // 空文件与超类型拒绝
  assert.throws(() => saveImage(dir, Buffer.alloc(0), 'image/png'), /bad size/);
  assert.throws(() => saveImage(dir, Buffer.from([1]), 'application/zip'), /unsupported/);

  // 旧目录清理
  const oldDir = path.join(dir, '2020-01-01');
  fs.mkdirSync(oldDir);
  fs.writeFileSync(path.join(oldDir, 'aaaaaaaaaaaa.jpg'), 'x');
  const removed = cleanupOldUploads(dir, 14);
  assert.equal(removed, 1);
  assert.ok(!fs.existsSync(oldDir));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('copy-mode 里:翻页/退出键原样交给模式,Enter/Tab/^C 等要先退模式再送', () => {
  assert.equal(keysNeedLiveMode(['Up']), false);
  assert.equal(keysNeedLiveMode(['PageDown', 'Escape']), false);
  assert.equal(keysNeedLiveMode(['Enter']), true);
  assert.equal(keysNeedLiveMode(['Tab']), true);
  assert.equal(keysNeedLiveMode(['C-c']), true);
  assert.equal(keysNeedLiveMode(['Up', 'Enter']), true);
});

test('滚轮报文:SGR 格式,64 上 65 下,按数量重复', () => {
  assert.equal(wheelReports('up', 2), '\u001b[<64;2;2M\u001b[<64;2;2M');
  assert.equal(wheelReports('down', 1), '\u001b[<65;2;2M');
});

import { checkAuth } from '../server/auth.js';
import {
  parseModelMenu, resolveModel, normalizeModelQuery, statusModel, modelCommand, screenTail, parseModelSaid, parseSwitchConfirm, Controller,
} from '../server/control.js';

// 真机抓的 /model 选择器(Claude Code 2.1.296,120 列)
const MENU = `❯ /model claude-fable-5-1
  ⎿  Set model to Fable 5.1 and saved as your default for new sessions
   Select model
   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,
   specify with --model.
     1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks
     2.  Opus 5.5               For complex work and everyday tasks
   ❯ 3.  Fable 5.1 ✔            For your toughest challenges
     4.  Sonnet 5.5             Most efficient for simpler tasks
     5.  Haiku 5.5              Fastest for quick answers
     6.  Haiku 4.5              Fastest for quick answers
     7.  Sonnet 5               Efficient for routine tasks
     8.  Opus 5                 Best for everyday, complex tasks
     9.  Fable 5                Most capable for your hardest and longest-running tasks
   ↓ 10. Opus 4.8               Best for everyday, complex tasks
      … +3 models
   ● High effort (default) ←/→ to adjust
   Enter to set as default · s to use this session only · Esc to cancel`;

test('输入占用:只看底部输入框,正文里回显的历史提问不算(真机抓的坑)', () => {
  const idle = '❯ /model\n  ⎿  Set model to Fable 5.1 for this session only\n────\n❯ \n────\n  [Fable 5.1] │ root';
  assert.ok(!inputBusy(idle), '历史提问 + 空输入框 = 不占用');
  assert.ok(inputBusy(idle.replace('❯ \n', '❯ 打了一半\n')), '历史提问 + 输入框有字 = 占用');
});

test('模型选择器解析:选项/高亮/当前/仅本会话提示,只认最后一个选择器', () => {
  const m = parseModelMenu(MENU);
  assert.ok(m.open && m.sessionOnly);
  assert.equal(m.highlighted, 3);
  assert.equal(m.options.length, 10);
  assert.deepEqual(m.options[0], { n: 1, label: 'Default (recommended)', current: false });
  assert.deepEqual(m.options[2], { n: 3, label: 'Fable 5.1', current: true });
  assert.equal(m.options[9].label, 'Opus 4.8', '↓ 标记不吞编号');
  assert.ok(!parseModelMenu('1. 正文里的编号列表\n2. 第二条').open, '没有选择器标题 = 没开');
});

test('模型名归一与匹配:家族名取最新,精确版本优先,别名/ID/1M 都认', () => {
  assert.deepEqual(normalizeModelQuery('claude-fable-5-1'), { q: 'fable 5.1', want1m: false });
  assert.deepEqual(normalizeModelQuery('Fable5'), { q: 'fable 5', want1m: false });
  assert.deepEqual(normalizeModelQuery('claude-opus-5-5[1m]'), { q: 'opus 5.5', want1m: true });
  assert.equal(normalizeModelQuery('claude-haiku-4-5-20251001').q, 'haiku 4.5');
  const opts = parseModelMenu(MENU).options.concat([{ n: 11, label: 'Opus 5.5 (1M context)' }]);
  const pick = (q) => resolveModel(opts, q)?.label ?? null;
  assert.equal(pick('fable'), 'Fable 5.1', '家族名 = 列表里第一个 = 最新');
  assert.equal(pick('opus'), 'Opus 5.5', '不会选中 Default 项');
  assert.equal(pick('fable 5'), 'Fable 5', '写死版本就给那个版本');
  assert.equal(pick('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(pick('opus 4'), 'Opus 4.8', '前缀取最新小版本');
  assert.equal(pick('default'), 'Default (recommended)');
  assert.equal(pick('opus[1m]'), 'Opus 5.5 (1M context)');
  assert.equal(pick('gpt-5'), null);
});

test('状态条模型 / /model 指令识别 / 屏幕末尾', () => {
  assert.equal(statusModel('正文 [Opus 5.5] 不算\n  [Fable 5.1] │ root │ ⏱️ 2m\n  Context ░ 0%'), 'Fable 5.1');
  assert.equal(statusModel('没有状态条'), null);
  assert.equal(modelCommand(' /model claude-fable-5-1 '), 'claude-fable-5-1');
  assert.equal(modelCommand('/model'), null, '不带参数 = 原样打开选择器');
  assert.equal(modelCommand('/models x'), null);
  assert.equal(screenTail('a\nb\nc\n\n\n', 2), 'b\nc');
});

test('切换结果:只认本次 /model 回显下面那行,屏上残留的旧结果不算', () => {
  const screen = `❯ /model
  ⎿  Set model to Opus 5.5 and saved as your default for new sessions
❯ 写个脚本
  ⎿  好的
❯ /model
  ⎿  Set model to Fable 5.1 for this session only
────
❯ 
────
  [Opus 5.5] │ root`;
  assert.deepEqual(parseModelSaid(screen), { label: 'Fable 5.1', session: true, line: 'Set model to Fable 5.1 for this session only' });
  assert.equal(parseModelSaid('❯ /model\n  ⎿  Kept model as Opus 5.5').label, 'Opus 5.5');
  assert.equal(parseModelSaid('❯ /model\n  ⎿  Set model to Sonnet 5.5 (default) and saved as your default for new sessions').label, 'Sonnet 5.5');
  assert.equal(parseModelSaid('正文\n  ⎿  Set model to Opus 5.5 for this session only'), null, '没有回显就不认');
});

test('切模型确认框:认出「Yes, switch」项及是否已高亮', () => {
  const dlg = `✻ Cooked for 5s
   Switch model?
   Your next response will be slower and use more tokens
   ❯ 1. Yes, switch to Sonnet 5.5
     2. No, go back`;
  assert.deepEqual(parseSwitchConfirm(dlg), { yes: '1', highlighted: true });
  assert.deepEqual(parseSwitchConfirm(dlg.replace('❯ 1.', '  1.').replace('  2. No', '❯ 2. No')), { yes: '1', highlighted: false });
  assert.equal(parseSwitchConfirm('Do you want to proceed?\n❯ 1. Yes'), null, '别的确认框不算');
});

test('Bearer 鉴权:对的放行不种 cookie,错的计失败', () => {
  const req = (h) => ({ headers: h, socket: { remoteAddress: '10.9.9.9' }, url: '/api/agent' });
  assert.deepEqual(checkAuth(req({ authorization: 'Bearer s3cret' }), 's3cret'), { ok: true });
  assert.equal(checkAuth(req({ authorization: 'Bearer nope' }), 's3cret').ok, false);
  assert.equal(checkAuth(req({ authorization: 'Basic s3cret' }), 's3cret').ok, false);
});

// 假 Claude Code:13 个模型、一屏 10 个、循环滚动、屏下藏几项就显示 "… +N models",行为照真机;
// history=true 时选中后多弹一道「Switch model?」确认
function fakeClaude({ state = 'idle' } = {}) {
  const labels = ['Default (recommended)', 'Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5.5', 'Haiku 4.5',
    'Sonnet 5', 'Opus 5', 'Fable 5', 'Opus 4.8', 'Opus 4.7', 'Opus 4.6', 'Opus 4.5'];
  const st = { open: false, h: 0, top: 0, model: 'Opus 5.5', said: '', state, typed: [], keys: [], persisted: null, confirm: null, history: false };
  const show = () => { if (st.h < st.top) st.top = st.h; if (st.h > st.top + 9) st.top = st.h - 9; };
  const apply = (key, label) => {
    st.prevModel = st.model;
    st.lagging = true;
    st.model = label === 'Default (recommended)' ? 'Opus 5.5' : label;
    st.said = `Set model to ${label}${key === 's' ? ' for this session only' : ' and saved as your default for new sessions'}`;
    if (key === 'Enter') st.persisted = st.model;
  };
  const render = () => {
    let s = `正文\n❯ /model\n  ⎿  Set model to Haiku 4.5 for this session only\n❯ 之前问过的话\n${st.said ? `❯ /model\n  ⎿  ${st.said}\n` : ''}`;
    if (st.state === 'working') s += '✽ Skedaddling… (3s · ↓ 88 tokens)\n';
    if (st.open) {
      s += '   Select model\n';
      for (let i = st.top; i < st.top + 10; i++) {
        const mark = i === st.h ? '❯' : i === st.top && i > 0 ? '↑' : i === st.top + 9 && i < labels.length - 1 ? '↓' : ' ';
        s += `   ${mark} ${i + 1}.  ${labels[i]}${labels[i] === st.model ? ' ✔' : ''}      desc\n`;
      }
      const below = labels.length - (st.top + 10);
      if (below > 0) s += `      … +${below} model${below > 1 ? 's' : ''}\n`;
      s += '   Enter to set as default · s to use this session only · Esc to cancel\n';
    } else if (st.confirm) {
      s += `   Switch model?\n   Your next response will be slower\n   ❯ 1. Yes, switch to ${st.confirm.label}\n     2. No, go back\n`;
    } else {
      s += '────\n❯ \n────\n';
    }
    const shown = st.lagging ? st.prevModel : st.model; // 状态条第一次截屏还是旧的
    st.lagging = false;
    return `${s}  [${shown}] │ root\n`;
  };
  return {
    st,
    labels,
    capture: async () => render(),
    sendText: async (name, text, { enter }) => {
      if (text === '/model' && enter) { st.open = true; st.h = labels.indexOf(st.model); show(); } else st.typed.push(text);
    },
    sendKeys: async (name, keys) => {
      for (const k of keys) {
        st.keys.push(k);
        if (st.confirm) {
          if (k === 'Enter' || k === '1') apply(st.confirm.key, st.confirm.label);
          st.confirm = null;
          continue;
        }
        if (!st.open) continue;
        if (k === 'Down') st.h = (st.h + 1) % labels.length;
        else if (k === 'Up') st.h = (st.h - 1 + labels.length) % labels.length;
        else if (k === 'Escape') st.open = false;
        else if (k === 's' || k === 'Enter') {
          st.open = false;
          if (st.history) st.confirm = { key: k, label: labels[st.h] };
          else apply(k, labels[st.h]);
        }
        show();
      }
    },
  };
}

test('控制器切模型:翻到屏外的项、默认按 s 只改本会话、persist 才按 Enter', async () => {
  const f = fakeClaude();
  const c = new Controller({ ...f, log: { log() {}, error() {} } });
  let r = await c.command('x', { text: '/model claude-fable-5-1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.model, 'Fable 5.1');
  assert.equal(r.scope, 'session');
  assert.deepEqual(f.st.typed, [], '/model <名> 不原样敲进去');
  assert.equal(f.st.persisted, null, '没动全机默认');

  r = await c.command('x', { model: 'opus 4.5' });
  assert.equal(r.model, 'Opus 4.5', '屏外第 13 项也能翻到');

  r = await c.command('x', { model: 'sonnet', persist: true });
  assert.equal(r.scope, 'default');
  assert.equal(f.st.persisted, 'Sonnet 5.5');

  f.st.history = true; // 有对话历史:多一道确认
  r = await c.command('x', { model: 'fable' });
  assert.equal(r.model, 'Fable 5.1', JSON.stringify(r));
  assert.ok(r.note, '确认过缓存作废要告诉调用方');
  f.st.history = false;

  // 当前模型在列表底部时,最新的 Fable 5.1 在屏外;只给家族名也必须挑到它而不是屏内的旧版 Fable 5
  f.st.model = 'Opus 4.5';
  f.st.top = 3;
  r = await c.command('x', { model: 'fable' });
  assert.equal(r.model, 'Fable 5.1', '家族名要在全列表里挑最新');

  r = await c.command('x', { model: 'gpt-5' });
  assert.equal(r.ok, false);
  assert.ok(r.available.includes('Opus 4.5'), '找不到时列出全部可选');
  assert.equal(f.st.open, false, '失败要 Esc 关掉选择器');
  assert.equal(c.recentOf('x').length, 6);
});

test('控制器安全门与排队:忙就不发,排队项等空闲才执行', async () => {
  const f = fakeClaude({ state: 'working' });
  const c = new Controller({ ...f, log: { log() {}, error() {} } });
  const r = await c.command('x', { text: '/compact' });
  assert.equal(r.busy, true);
  assert.deepEqual(f.st.typed, []);

  const q = c.enqueue('x', { model: 'fable' });
  assert.ok(q.id);
  await c.tickQueue();
  assert.equal(c.listQueue('x').length, 1, '还在忙,不动');
  f.st.state = 'idle';
  await c.tickQueue();
  assert.equal(c.listQueue('x').length, 0);
  assert.equal(f.st.model, 'Fable 5.1');
  assert.ok(c.recentOf('x')[0].source.startsWith('queue'));

  const forced = await new Controller({ ...fakeClaude({ state: 'working' }), log: { log() {}, error() {} } })
    .command('x', { text: 'hi' }, { force: true });
  assert.equal(forced.ok, true, 'force 跳过安全门');
});

test('滚动行数:缺省 5,整数夹在 1..50,非整数一律回缺省', () => {
  assert.equal(scrollLines(undefined), 5);
  assert.equal(scrollLines(12), 12);
  assert.equal(scrollLines(0), 1);
  assert.equal(scrollLines(999), 50);
  assert.equal(scrollLines('7'), 5);
  assert.equal(scrollLines(2.5), 5);
});

test('认 codex 进程:原生二进制与 npm 的 node 包装都算,参数里提到 codex 的别的程序不算', () => {
  assert.ok(isCodexArgs('node /usr/bin/codex'));
  assert.ok(isCodexArgs('/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'));
  assert.ok(isCodexArgs('codex --model gpt-6.1'));
  assert.ok(!isCodexArgs('node /root/tapmux/server/index.js'));
  assert.ok(!isCodexArgs('vim notes-about-codex'));
  assert.ok(!isCodexArgs('grep codex log.txt'));
});

test('codex 翻页累积:攒够一页才翻,停手或换方向清零', () => {
  const pager = makePager(1500);
  assert.equal(pager('s', 'up', 3, 10, 0), 0);
  assert.equal(pager('s', 'up', 4, 10, 100), 0);
  assert.equal(pager('s', 'up', 5, 10, 200), 1, '累计 12 行 → 1 页,余 2');
  assert.equal(pager('s', 'up', 8, 10, 300), 1, '余 2 + 8 = 10 → 1 页');
  assert.equal(pager('s', 'up', 25, 10, 400), 2, '一次滑很远 → 多页');
  assert.equal(pager('s', 'down', 9, 10, 500), 0, '换方向清零');
  assert.equal(pager('s', 'down', 9, 10, 3000), 0, '停手超时清零,不带上次的 9');
  assert.equal(pager('t', 'down', 10, 10, 3000), 1, '会话之间互不影响');
});
