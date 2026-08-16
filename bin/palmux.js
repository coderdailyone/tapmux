#!/usr/bin/env node
// palmux CLI:默认启动桥接服务;install-service 生成 systemd user unit
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const cmd = process.argv[2];

if (cmd === 'install-service') {
  const entry = fileURLToPath(new URL('../server/index.js', import.meta.url));
  const unit = `[Unit]
Description=palmux - phone-friendly web bridge for tmux / Claude Code
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
  const file = path.join(dir, 'palmux.service');
  fs.writeFileSync(file, unit);
  console.log(`已写入 ${file}`);
  console.log('接着执行:');
  console.log('  systemctl --user daemon-reload && systemctl --user enable --now palmux');
} else if (cmd === undefined || cmd === 'start') {
  await import('../server/index.js');
} else {
  console.log(`用法: palmux [start]          启动桥接服务(默认)
      palmux install-service  生成 systemd user unit 并打印启用命令`);
  process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1);
}
