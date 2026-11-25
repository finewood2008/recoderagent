#!/usr/bin/env node
// 进程内录音服务，只接受独立窗口发来的回环请求。
import http from 'node:http';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, RE } from './lib/util.mjs';
import { media } from './lib/media.mjs';
import { usbInputs } from './lib/usb-inputs.mjs';
import { audioType } from './lib/audio-input.mjs';
import * as M from './lib/meetings.mjs';
import * as Lib from './lib/library.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const HOST = '127.0.0.1';
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/launch.js': ['launch.js', 'text/javascript; charset=utf-8'],
  '/executive-disk.js': ['executive-disk.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/executive-disk.css': ['executive-disk.css', 'text/css; charset=utf-8'],
  '/box-connection.css': ['box-connection.css', 'text/css; charset=utf-8'],
  '/disk-agent.svg': ['disk-agent.svg', 'image/svg+xml'],
  '/pcm-worklet.js': ['pcm-worklet.js', 'text/javascript; charset=utf-8'],
};

const LIMIT_JSON = 512 * 1024;

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  const payload = isBuf ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SEC_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': isBuf ? headers['Content-Type'] || 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > limit) { req.resume(); return reject(new HttpError(413, '请求体过大')); }
    const parts = [];
    let size = 0, done = false;
    req.on('data', (d) => {
      if (done) return;
      size += d.length;
      if (size > limit) { done = true; req.resume(); reject(new HttpError(413, '请求体过大')); return; }
      parts.push(d);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

async function readJsonBody(req) {
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') throw new HttpError(415, '需要 Content-Type: application/json');
  const buf = await readBody(req, LIMIT_JSON);
  if (!buf.length) return {};
  let v;
  try { v = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'JSON 无法解析'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, '请求体必须是 JSON 对象');
  return v;
}

async function sendFile(req, res, file, type, extra = {}) {
  const st = await fs.stat(file);
  const size = st.size;
  let start = 0, end = size - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(range);
    if (!m || (!m[1] && !m[2])) { res.writeHead(416, { ...SEC_HEADERS, 'Content-Range': `bytes */${size}` }); return res.end(); }
    if (!m[1]) { start = Math.max(0, size - Number(m[2])); }
    else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
    if (start > end || start >= size) { res.writeHead(416, { ...SEC_HEADERS, 'Content-Range': `bytes */${size}` }); return res.end(); }
    status = 206;
  }
  res.writeHead(status, {
    ...SEC_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes',
    'Content-Length': size ? end - start + 1 : 0,
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    ...extra,
  });
  if (req.method === 'HEAD' || !size) return res.end();
  createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

function checkRequest(req, { origin, viewKey }) {
  if (req.headers['x-recording-view'] !== viewKey) throw new HttpError(403, '请从会议录音智能体打开');
  if (req.headers.host !== new URL(origin).host) throw new HttpError(421, 'Host 不受信任');
  if (req.headers.origin !== undefined && req.headers.origin !== origin) throw new HttpError(403, 'Origin 不受信任');
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, '拒绝跨站请求');
  if ((req.url || '').length > 2048) throw new HttpError(414, 'URL 过长');
}

function param(v, re, what) {
  if (!re.test(v)) throw new HttpError(400, `${what} 无效`);
  return v;
}

async function acceptRecordingFile(req, name, params) {
  if (!name || !audioType(name)) throw new HttpError(415, '请选择受支持的音频文件');
  if (req.headers['content-type'] !== 'application/octet-stream') throw new HttpError(415, '需要二进制录音文件');
  const size = Number(req.headers['content-length']);
  const cap = 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(size) || size < 1) throw new HttpError(400, '录音文件大小无效');
  if (size > cap) { req.resume(); throw new HttpError(413, '单份原音上限为 1 GiB'); }
  const temp = path.join(M.P.tmp, randomUUID() + path.extname(name).toLowerCase());
  let seen = 0;
  const guard = new Transform({ transform(bytes, _encoding, cb) {
    seen += bytes.length;
    if (seen > size) cb(new HttpError(400, '文件长度不符'));
    else cb(null, bytes);
  } });
  try {
    await pipeline(req, guard, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    if (seen !== size) throw new HttpError(400, '录音传输未完成');
    return await M.importAudio(temp, name, {
      source: 'disk',
      allowCloudSummary: params.get('allowCloudSummary') === 'true',
      scenario: params.get('scenario') || undefined,
      templateId: params.get('templateId') || undefined,
      templateRevision: params.has('templateRevision') ? Number(params.get('templateRevision')) : undefined,
    });
  } finally { await fs.rm(temp, { force: true }); }
}

async function route(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  const seg = p.split('/').filter(Boolean);
  const is = (m) => method === m;

  if ((is('GET') || is('HEAD')) && Object.hasOwn(STATIC, p)) {
    const [file, type] = STATIC[p];
    return sendFile(req, res, path.join(PUBLIC, file), type);
  }
  if (seg[0] !== 'api') throw new HttpError(404, '未找到');

  if (p === '/api/usb-inputs' && is('GET')) return send(res, 200, await usbInputs());
  if (p === '/api/health' && is('GET')) return send(res, 200, { desktop: true, media: await media.status() });
  if (p === '/api/import-audio' && is('POST')) {
    const imported = await acceptRecordingFile(req, url.searchParams.get('name') || '', url.searchParams);
    return send(res, 202, imported);
  }
  if (p === '/api/settings') {
    if (is('GET')) return send(res, 200, await Lib.getSettings());
    if (is('PUT')) return send(res, 200, await Lib.putSettings(await readJsonBody(req)));
  }
  if (p === '/api/minutes-templates') {
    if (is('GET')) return send(res, 200, await Lib.listMinutesTemplates());
    if (is('PUT')) return send(res, 200, await Lib.saveMinutesTemplate(await readJsonBody(req)));
  }
  if (p === '/api/meetings') {
    if (is('GET')) return send(res, 200, { meetings: M.listMeetings() });
    if (is('POST')) {
      const b = await readJsonBody(req);
      const project = await M.createMeeting({
        title: b.title, inputLabel: b.inputLabel, memoryEnabled: false, source: 'disk',
        scenario: b.scenario, depth: b.depth, preferences: { ...b.preferences, checkMemory: false }, focusNotes: b.focusNotes,
        allowCloudSummary: b.allowCloudSummary === true,
        sampleRate: b.sampleRate, channels: b.channels, templateId: b.templateId, templateRevision: b.templateRevision,
      });
      return send(res, 201, project);
    }
  }
  if (seg[1] === 'meetings' && seg.length >= 3) {
    const id = param(seg[2], RE.meeting, '会议 ID');
    const sub = seg[3];
    if (seg.length === 3) {
      if (is('GET')) return send(res, 200, M.view(id));
      if (is('PATCH')) {
        const body = await readJsonBody(req);
        return send(res, 200, await M.patchMeeting(id, {
          ...body, memoryEnabled: false,
          ...(body.preferences && { preferences: { ...body.preferences, checkMemory: false } }),
        }));
      }
    }
    if (seg.length === 4) {
      if (sub === 'chunks' && is('POST')) {
        const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (ct !== 'application/octet-stream') throw new HttpError(415, '需要 Content-Type: application/octet-stream（PCM16LE 16 kHz 单声道）');
        const raw = url.searchParams.get('seq') ?? req.headers['x-chunk-seq'];
        if (typeof raw !== 'string' || !RE.seq.test(raw)) throw new HttpError(400, 'seq 必须是 0–999999 的整数');
        const buf = await readBody(req, M.LIMITS.chunkMaxBytes);
        return send(res, 201, await M.saveChunk(id, Number(raw), buf));
      }
      if (sub === 'live' && is('POST')) {
        if (req.headers['content-type'] !== 'application/octet-stream') throw new HttpError(415, '需要 PCM 音频帧');
        const frame = await readBody(req, 6400);
        if (!frame.length || frame.length % 2) throw new HttpError(400, 'PCM 音频帧长度无效');
        return send(res, 200, await M.pushLiveFrame(id, frame));
      }
      if (sub === 'finish' && is('POST')) return send(res, 202, await M.finishMeeting(id, await readJsonBody(req)));
      if (sub === 'retry' && is('POST')) {
        const b = await readJsonBody(req);
        return send(res, 202, await M.retryStage(id, b.stage, b));
      }
      if (sub === 'advisor-stage' && is('POST')) return send(res, 200, await M.triggerManualStage(id));
      if (sub === 'advisor-chat' && is('POST')) return send(res, 200, await M.chatWithAdvisor(id, await readJsonBody(req)));
      if (sub === 'drafts' && is('POST')) return send(res, 200, await M.generateDraftVariant(id, await readJsonBody(req)));
      if (sub === 'audio' && (is('GET') || is('HEAD'))) {
        const file = M.audioFile(id);
        return sendFile(req, res, file, audioType(file) || 'application/octet-stream');
      }
      if (sub === 'minutes' && is('PUT')) return send(res, 200, await M.saveMinutes(id, await readJsonBody(req)));
      if (sub === 'save' && is('POST')) {
        const { destination, version } = await readJsonBody(req);
        if (destination !== 'space') throw new HttpError(400, '请选择盒子空间。');
        return send(res, 200, await M.saveDestination(id, { destination, version }));
      }
      if (sub === 'confirm' && is('POST')) return send(res, 200, await M.confirmMinutes(id, await readJsonBody(req)));
    }
    if (seg.length === 5) {
      if (sub === 'speakers' && is('PUT')) {
        const spkId = param(seg[4], /^spk_[A-Za-z0-9_]{1,24}$/, '发言人 ID');
        return send(res, 200, await M.renameSpeaker(id, spkId, await readJsonBody(req)));
      }
    }
    if (seg.length === 6) {
      if (sub === 'drafts' && seg[5] === 'activate' && is('POST')) {
        const draftId = param(seg[4], /^dr-[0-9a-f]{6,16}$/, '版本 ID');
        return send(res, 200, await M.activateDraft(id, draftId));
      }
      if (sub === 'segments' && seg[5] === 'revert' && is('POST')) {
        const segIdx = Number(param(seg[4], RE.seq, '段落序号'));
        return send(res, 200, await M.revertSegmentCorrection(id, segIdx, await readJsonBody(req)));
      }
    }
  }
  throw new HttpError(404, '未找到');
}

export async function startRecordingServer(dataDir, viewKey) {
  await M.initStore(dataDir);
  let origin;
  const server = http.createServer(async (req, res) => {
    try {
      checkRequest(req, { origin, viewKey });
      const rawPath = String(req.url || '/').split('?')[0];
      if (!rawPath.startsWith('/') || /\.\.|%2e|%2f|%5c|\\/i.test(rawPath)) throw new HttpError(400, '路径无效');
      const url = new URL(req.url, 'http://127.0.0.1');
      // 所有合法路径都是 ASCII 且不含编码字符；拒绝穿越与编码绕过
      if (!/^[A-Za-z0-9/_.-]*$/.test(url.pathname) || url.pathname.includes('..')) throw new HttpError(400, '路径无效');
      await route(req, res, url);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (res.headersSent) return res.destroy();
      send(res, status, { error: status === 500 ? '服务器内部错误' : e.message, ...(e.extra || {}) });
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 20000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, resolve);
  });
  origin = `http://${HOST}:${server.address().port}`;
  return { origin, close: () => server.close() };
}
