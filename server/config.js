import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'tapmux');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  port: 7802,
  bind: '0.0.0.0',
  uploadDir: path.join(os.homedir(), 'claude-uploads'),
  dataDir: path.join(os.homedir(), '.local', 'share', 'tapmux'),
  uploadRetentionDays: 14,
  // 会话内新建 Claude Code 时执行的命令
  claudeCommand: 'claude',
};

// 项目曾用名 palmux(2026-08 改名 tapmux):老部署目录整体改名,token 与纳管清单无感迁移
function migrateLegacy(oldPath, newPath) {
  if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
}

export function loadConfig() {
  migrateLegacy(path.join(os.homedir(), '.config', 'palmux'), CONFIG_DIR);
  migrateLegacy(path.join(os.homedir(), '.local', 'share', 'palmux'), DEFAULTS.dataDir);
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let saved = {};
  if (fs.existsSync(CONFIG_FILE)) {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
  if (typeof saved.dataDir === 'string' && saved.dataDir.endsWith(`${path.sep}palmux`)) {
    delete saved.dataDir; // 旧配置里写死的老路径,放行到新默认值
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
