import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'palmux');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  port: 7802,
  bind: '0.0.0.0',
  uploadDir: path.join(os.homedir(), 'claude-uploads'),
  dataDir: path.join(os.homedir(), '.local', 'share', 'palmux'),
  uploadRetentionDays: 14,
  // 会话内新建 Claude Code 时执行的命令
  claudeCommand: 'claude',
};

export function loadConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let saved = {};
  if (fs.existsSync(CONFIG_FILE)) {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
  const config = { ...DEFAULTS, ...saved };
  if (!config.token) {
    config.token = crypto.randomBytes(24).toString('hex');
  }
  // 回写(补齐新增默认项),权限收紧:token 即 shell
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.mkdirSync(config.uploadDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  return config;
}

export { CONFIG_FILE };
