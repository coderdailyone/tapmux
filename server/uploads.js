import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const SERVE_RE = /^\/uploads\/(\d{4}-\d{2}-\d{2})\/([a-f0-9]{12}\.(?:jpg|png|webp|gif))$/;

export function extForMime(mime) {
  return EXT_BY_MIME[String(mime || '').split(';')[0].trim()] || null;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function saveImage(uploadDir, buf, mime) {
  const ext = extForMime(mime);
  if (!ext) throw Object.assign(new Error('unsupported image type'), { code: 'BAD_TYPE' });
  if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error('bad size'), { code: 'BAD_SIZE' });
  }
  const day = today();
  const dir = path.join(uploadDir, day);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, buf, { mode: 0o600 });
  return { path: abs, url: `/uploads/${day}/${name}` };
}

// 仅允许形如 /uploads/2026-08-15/a1b2c3d4e5f6.jpg 的路径,结构上杜绝穿越
export function resolveServable(uploadDir, urlPath) {
  const m = SERVE_RE.exec(urlPath);
  if (!m) return null;
  const abs = path.join(uploadDir, m[1], m[2]);
  return fs.existsSync(abs) ? abs : null;
}

export function contentTypeFor(absPath) {
  const ext = path.extname(absPath).slice(1);
  return { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'application/octet-stream';
}

export function cleanupOldUploads(uploadDir, retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
  let removed = 0;
  if (!fs.existsSync(uploadDir)) return removed;
  for (const day of fs.readdirSync(uploadDir)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (new Date(day + 'T00:00:00').getTime() >= cutoff) continue;
    const dir = path.join(uploadDir, day);
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f));
      removed += 1;
    }
    fs.rmdirSync(dir);
  }
  return removed;
}
