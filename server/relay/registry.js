import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 设备注册表:邀请码单次有效,设备 token 只存哈希。JSON 落盘,备份即拷文件。
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export class Registry {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(dataDir, 'registry.json');
    this.data = { users: {}, devices: {}, invites: {} };
    if (fs.existsSync(this.file)) {
      this.data = { users: {}, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
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

  // ---- 用户:一人一 token,机器挂在人名下 ----
  createUser(name) {
    if (!Registry.validName(name)) return { error: '用户名只能用小写字母数字连字符' };
    if (this.data.users[name]) return { error: '用户已存在' };
    const token = crypto.randomBytes(24).toString('hex');
    this.data.users[name] = { tokenHash: sha256(token), createdAt: Date.now() };
    this.save();
    return { name, userToken: token };
  }

  // token → 用户名(恒时比较;用户数少,遍历即可)
  authUser(token) {
    if (typeof token !== 'string' || !token) return null;
    const h = Buffer.from(sha256(token), 'hex');
    for (const [name, u] of Object.entries(this.data.users)) {
      const want = Buffer.from(u.tokenHash, 'hex');
      if (h.length === want.length && crypto.timingSafeEqual(h, want)) return name;
    }
    return null;
  }

  isAdmin(name) {
    return Boolean(this.data.users[name]?.admin);
  }

  promote(name, on = true) {
    if (!this.data.users[name]) return false;
    this.data.users[name].admin = on;
    this.save();
    return true;
  }

  revokeUser(name) {
    if (!this.data.users[name]) return false;
    delete this.data.users[name];
    this.save();
    return true;
  }

  listUsers() {
    return Object.entries(this.data.users).map(([name, u]) => ({
      name,
      devices: Object.entries(this.data.devices).filter(([, d]) => d.owner === name).map(([n]) => n),
    }));
  }

  claimDevice(device, user) {
    if (!this.data.devices[device] || !this.data.users[user]) return false;
    this.data.devices[device].owner = user;
    this.save();
    return true;
  }

  // 邀请码归属某用户:用它注册的设备自动挂到该用户名下
  createInvite(user) {
    if (!this.data.users[user]) return { error: '用户不存在,先 user-add' };
    const code = crypto.randomBytes(6).toString('hex');
    this.data.invites[code] = { createdAt: Date.now(), used: false, user };
    this.save();
    return { code };
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
      tokenHash: sha256(token),
      owner: inv.user || null,
      createdAt: Date.now(),
      lastSeen: 0,
    };
    this.save();
    return { name, deviceToken: token };
  }

  ownerOf(device) {
    return this.data.devices[device]?.owner || null;
  }

  auth(name, token) {
    const d = this.data.devices[name];
    if (!d || typeof token !== 'string') return false;
    const h = crypto.createHash('sha256').update(token).digest();
    const want = Buffer.from(d.tokenHash, 'hex');
    return h.length === want.length && crypto.timingSafeEqual(h, want);
  }

  touch(name, version) {
    if (this.data.devices[name]) {
      this.data.devices[name].lastSeen = Date.now();
      if (version) this.data.devices[name].version = version;
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
