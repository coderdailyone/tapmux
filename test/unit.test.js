import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validSessionName, validKeys } from '../server/tmux.js';
import { tokensEqual, parseCookies } from '../server/auth.js';
import { extForMime, saveImage, resolveServable, cleanupOldUploads } from '../server/uploads.js';
import { previewFromCapture, detectClaudeState } from '../server/preview.js';

test('Claude 状态感知:等确认 > 干活中 > 空闲', () => {
  assert.equal(detectClaudeState('✻ Crunching… (esc to interrupt)'), 'working');
  assert.equal(detectClaudeState('✻ Brewed for 46s\n  tokens · esc to interrupt'), 'working');
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
  assert.deepEqual(parseCookies('a=1; palmux_token=xyz'), { a: '1', palmux_token: 'xyz' });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palmux-test-'));
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
