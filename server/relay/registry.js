import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 设备注册表:邀请码单次有效,设备 token 只存哈希。JSON 落盘,备份即拷文件。
export class Registry {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(dataDir, 'registry.json');
    this.data = { devices: {}, invites: {} };
    if (fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // 服务运行期间 CLI 可能新增了邀请码/吊销了设备:注册与鉴权前重读盘面
  reload() {
    if (fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    }
  }

  createInvite() {
    const code = crypto.randomBytes(6).toString('hex');
    this.data.invites[code] = { createdAt: Date.now(), used: false };
    this.save();
    return code;
  }

  static validName(name) {
    return typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,23}$/.test(name);
  }

  // 邀请码换设备凭据;码单次销毁,名字唯一
  register(invite, name) {
    const inv = this.data.invites[invite];
    if (!inv || inv.used) return { error: '邀请码无效或已用过' };
    if (!Registry.validName(name)) return { error: '设备名只能用小写字母数字连字符,24 字以内' };
    if (this.data.devices[name]) return { error: '设备名已存在' };
    const token = crypto.randomBytes(24).toString('hex');
    inv.used = true;
    inv.usedBy = name;
    this.data.devices[name] = {
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      createdAt: Date.now(),
      lastSeen: 0,
    };
    this.save();
    return { name, deviceToken: token };
  }

  auth(name, token) {
    const d = this.data.devices[name];
    if (!d || typeof token !== 'string') return false;
    const h = crypto.createHash('sha256').update(token).digest();
    const want = Buffer.from(d.tokenHash, 'hex');
    return h.length === want.length && crypto.timingSafeEqual(h, want);
  }

  touch(name) {
    if (this.data.devices[name]) {
      this.data.devices[name].lastSeen = Date.now();
      this.save();
    }
  }

  revoke(name) {
    if (!this.data.devices[name]) return false;
    delete this.data.devices[name];
    this.save();
    return true;
  }

  list() {
    return Object.entries(this.data.devices).map(([name, d]) => ({ name, ...d, tokenHash: undefined }));
  }
}
