import fs from 'node:fs';
import path from 'node:path';

// 纳管清单:哪些 tmux 会话归 palmux 网页管理。状态存本机,VPS 无感。
export class ManagedStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'sessions.json');
    this.managed = new Map();
    this.load();
  }

  load() {
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.managed = new Map(Object.entries(raw.managed || {}));
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ managed: Object.fromEntries(this.managed) }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  has(name) {
    return this.managed.has(name);
  }

  add(name, via) {
    this.managed.set(name, { addedAt: Date.now(), via });
    this.save();
  }

  remove(name) {
    if (this.managed.delete(name)) this.save();
  }

  names() {
    return [...this.managed.keys()];
  }
}
