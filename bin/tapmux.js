#!/usr/bin/env node
// tapmux CLI:默认启动桥接服务;install-service 生成 systemd user unit
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const cmd = process.argv[2];

if (cmd === 'install-service') {
  const entry = fileURLToPath(new URL('../server/index.js', import.meta.url));
  const unit = `[Unit]
Description=tapmux - phone-friendly web bridge for tmux / Claude Code
After=network.target

[Service]
ExecStart=${process.execPath} ${entry}
Restart=always
RestartSec=3
Environment=NODE_ENV=production
# 桥接服务死亡绝不能连坐 tmux 服务器(tmux 可能被本服务按需拉起而落在同一 cgroup)
KillMode=process

[Install]
WantedBy=default.target
`;
  const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'tapmux.service');
  fs.writeFileSync(file, unit);
  console.log(`已写入 ${file}`);
  console.log('接着执行:');
  console.log('  systemctl --user daemon-reload && systemctl --user enable --now tapmux');
  // linger 未开时,SSH 断开会连坐 user 服务(真机踩过:掉线时间=用户离线时间)
  try {
    const { execSync } = await import('node:child_process');
    const who = os.userInfo().username;
    if (!/Linger=yes/.test(execSync(`loginctl show-user ${who} -p Linger`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString())) {
      console.log(`⚠️  linger 未开启:SSH 断开后服务会被系统回收。执行一次:`);
      console.log(`  loginctl enable-linger ${who}`);
    }
  } catch {}
} else if (cmd === 'relay-join') {
  // tapmux relay-join <https://relay域名> <邀请码> <设备名> [代理url]
  const [base, invite, name, proxyUrl] = process.argv.slice(3);
  if (!base || !invite || !name) {
    console.error('用法: tapmux relay-join <https://relay域名> <邀请码> <设备名> [代理url]');
    process.exit(1);
  }
  const res = await fetch(`${base.replace(/\/$/, '')}/relay/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invite, name }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    console.error(`注册失败: ${data.error || res.status}`);
    process.exit(1);
  }
  const { loadConfig, CONFIG_FILE } = await import('../server/config.js');
  const cfg = loadConfig();
  cfg.relay = {
    url: base.replace(/^http/, 'ws').replace(/\/$/, ''),
    deviceName: data.name,
    deviceToken: data.deviceToken,
    proxyUrl: proxyUrl || '',
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  console.log(`已接入 relay,设备名 ${data.name};重启服务生效(systemctl --user restart tapmux)`);
  console.log(`访问入口: ${base.replace(/\/$/, '')}/d/${data.name}/?token=<本机token>`);
} else if (cmd === undefined || cmd === 'start') {
  await import('../server/index.js');
} else {
  console.log(`用法: tapmux [start]          启动桥接服务(默认)
      tapmux install-service  生成 systemd user unit 并打印启用命令
      tapmux relay-join <url> <邀请码> <设备名> [代理url]  接入 relay`);
  process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1);
}
