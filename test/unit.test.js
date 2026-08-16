import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validSessionName, validKeys } from '../server/tmux.js';
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
