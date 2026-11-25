// 通用工具：原子写入、按键串行锁、ID 生成与校验、文本清理。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SAMPLE_RATE = 16000;

export async function writeFileAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

export const writeJson = (file, obj) => writeFileAtomic(file, JSON.stringify(obj, null, 2));

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
    throw e;
  }
}

const locks = new Map();
/** 同一 key 的异步操作严格串行。 */
export function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
export const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');

export function newMeetingId(d = new Date()) {
  return `m-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${hex(3)}`;
}
export const newItemId = () => `i-${hex(5)}`;
export const newVaultId = () => `v-${hex(5)}`;
export const newMaterialId = () => `mat-${hex(6)}`;
export const newMemoryId = () => `mem-${hex(6)}`;

export const RE = {
  meeting: /^m-\d{8}-\d{6}-[0-9a-f]{6}$/,
  item: /^i-[0-9a-f]{10}$/,
  vault: /^v-[0-9a-f]{10}$/,
  material: /^mat-[0-9a-f]{12}$/,
  seq: /^(0|[1-9]\d{0,5})$/,
};

/** 去掉控制字符（保留换行/制表），裁剪长度。 */
export function cleanText(v, max = 500, { multiline = false } = {}) {
  if (v === undefined || v === null) return '';
  let s = String(v).normalize('NFC');
  s = multiline
    ? s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    : s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  s = s.replace(/[‪-‮⁦-⁩]/g, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** 适合作为目录名的安全片段。 */
export function safeName(v, fallback = '未命名会议') {
  let s = cleanText(v, 60)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!s) s = fallback;
  return s.slice(0, 40);
}

export function fmtMs(ms) {
  const t = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function localStamp(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 确保 child 在 parent 目录内部（防路径穿越）。 */
export function insideDir(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
