import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from './util.mjs';

const PREFIX = '/api/services/wanx.media/v1';
const ASR = 'audio.transcribe';
const LIVE = 'audio.transcribe.streaming';
const SUMMARY = 'text.summarize';
const jobPath = (id) => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('媒体作业 ID 无效');
  return '/jobs/' + id;
};
const retryable = (e) => e.status === 429 || e.status >= 500 || !e.status;

export async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}

export function createMedia(host, grant, mode = 'box', expectedInstance) {
  let discovery;
  let ownerScope;
  let invalidated = false;
  host?.onSessionInvalidated?.(() => { discovery = null; ownerScope = null; invalidated = true; });
  function unavailable(reason) {
    return Object.assign(new Error(reason), { offline: true });
  }
  async function call(route, { method = 'GET', body } = {}) {
    if (!host) throw unavailable('需要匹配的桌面 Host 会话和媒体授权');
    if (invalidated) throw unavailable('盒子会话已失效，请使用新的授权会话');
    const headers = grant ? { 'X-Media-Grant': grant } : {};
    if (Buffer.isBuffer(body)) headers['Content-Type'] = 'application/octet-stream';
    const response = await host.request(PREFIX + route, { method, body, headers, signal: AbortSignal.timeout(25000) });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const code = typeof data?.code === 'string' && /^[A-Z_0-9]{1,80}$/.test(data.code) ? data.code : 'HTTP_' + response.status;
      throw Object.assign(new Error(code), { status: response.status, offline: [401, 403, 404, 503].includes(response.status) });
    }
    if (!data || typeof data !== 'object') throw new Error('媒体服务回执无效');
    return data;
  }
  async function capabilities() {
    if (discovery && Date.now() < discovery.validUntil) return discovery.result;
    if (!host) throw unavailable('等待盒子授权接入');
    const context = await host.context();
    if (context?.connection !== 'ready') throw unavailable('请先连接目标盒子');
    const result = await call('/capabilities');
    if (result.processingLocation !== 'box' || !Array.isArray(result.capabilities)) throw new Error('盒端媒体能力回执无效');
    if (mode === 'box' && expectedInstance && result.instance !== expectedInstance) throw unavailable('媒体授权实例不匹配');
    const userId = context.principalId || context.accountId || context.user?.id;
    if (mode === 'box' && (!context.boxId || !userId || !result.instance)) throw unavailable('盒端用户或应用身份不完整');
    ownerScope = mode === 'demo' ? 'demo' : createHash('sha256').update(JSON.stringify([context.boxId, userId, result.instance])).digest('hex');
    discovery = { validUntil: Date.now() + 8000, result };
    return result;
  }
  async function requireCapability(capability) {
    const discovered = await capabilities();
    const info = discovered.capabilities.find((entry) => entry.id === capability && entry.configured === true);
    if (!info) throw unavailable('当前盒子还未开通 ' + capability);
    return { ...discovered, info };
  }
  async function waitJob(job, capability, hash, retryFailed, onJob) {
    const path = jobPath(job.id);
    const id = job.id;
    if (job.state === 'failed' && retryFailed && job.error !== 'AUDIO_NO_SPEECH') {
      job = await call(path + '/retry', { method: 'POST' });
    }
    const deadline = Date.now() + 60 * 60 * 1000;
    let consecutiveErrors = 0;
    while (['queued', 'running'].includes(job.state)) {
      onJob?.(job);
      await delay(mode === 'demo' ? 20 : 1000);
      if (Date.now() > deadline) throw new Error('等待盒端作业超时，可从已提交的作业继续');
      try {
        job = await call(path);
        consecutiveErrors = 0;
      } catch (e) {
        if (!retryable(e) || ++consecutiveErrors > 4) throw e;
      }
    }
    onJob?.(job);
    if (job.state !== 'done') {
      if (job.error === 'AUDIO_NO_SPEECH') return { text: '', segments: [] };
      const code = typeof job.error === 'string' && /^[A-Z_0-9]{1,80}$/.test(job.error) ? job.error : '媒体作业未完成';
      throw new Error(code);
    }
    const receipt = await call(path + '/result');
    if (receipt.jobId !== id || receipt.capability !== capability || receipt.inputSha256 !== hash || !receipt.result) {
      throw new Error('媒体结果与输入不一致');
    }
    return receipt.result;
  }
  async function upload(job, file, size, chunkBytes, onProgress) {
    const path = jobPath(job.id);
    const handle = await fs.open(file, 'r');
    try {
      let consecutiveErrors = 0;
      while (job.state === 'uploading' && job.offset < size) {
        const offset = job.offset;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('媒体续传偏移无效');
        const count = Math.min(chunkBytes, size - offset);
        const bytes = Buffer.alloc(count);
        const { bytesRead } = await handle.read(bytes, 0, count, offset);
        if (bytesRead !== count) throw new Error('上传期间音频文件发生变化');
        try {
          const ack = await call(path + '/input?offset=' + offset, { method: 'PUT', body: bytes });
          if (ack.offset !== offset + count) throw new Error('分片回执偏移不符');
          job.offset = ack.offset;
          consecutiveErrors = 0;
          onProgress?.(job);
        } catch (e) {
          if ((!retryable(e) && e.status !== 409) || ++consecutiveErrors > 4) throw e;
          await delay(mode === 'demo' ? 20 : consecutiveErrors * 1000);
          job = await call(path);
        }
      }
    } finally { await handle.close(); }
    if (job.state === 'uploading') {
      if (job.offset !== size) throw new Error('原音仍有片段待上传');
      job = await call(path + '/submit', { method: 'POST' });
    }
    return job;
  }

  async function transcribe(file, requestId, { retryFailed = false, onJob } = {}) {
    const { chunkBytes, maxInputBytes } = await requireCapability(ASR);
    const size = (await fs.stat(file)).size;
    if (!Number.isSafeInteger(maxInputBytes) || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 8 * 1024 * 1024) throw new Error('媒体上传限制无效');
    if (!size || size > maxInputBytes) throw new Error('音频超出盒端单文件大小限制');
    const hash = await fileDigest(file);
    let job = await call('/jobs', { method: 'POST', body: { requestId, capability: ASR, size, sha256: hash, options: {} } });
    onJob?.(job);
    if (job.state === 'uploading') job = await upload(job, file, size, chunkBytes, onJob);
    return waitJob(job, ASR, hash, retryFailed, onJob);
  }
  async function ensureTemplate(name, instructions) {
    await requireCapability(SUMMARY);
    const { templates } = await call('/summary-templates');
    if (!Array.isArray(templates)) throw new Error('盒端模板列表无效');
    const prior = templates.find((t) => t.name === name && !t.isBuiltin);
    if (prior?.instructions === instructions) return prior.id;
    if (prior) {
      return (await call('/summary-templates/' + encodeURIComponent(prior.id), {
        method: 'PUT', body: { name, instructions, expectedRevision: prior.revision },
      })).id;
    }
    return (await call('/summary-templates', { method: 'POST', body: { name, instructions } })).id;
  }
  async function summarize(text, templateId, requestId, retryFailed = false) {
    await requireCapability(SUMMARY);
    if (!text || Buffer.byteLength(text) > 32768) throw new Error('总结输入超过盒端限制');
    const hash = createHash('sha256').update(text).digest('hex');
    const job = await call('/summaries', { method: 'POST', body: { text, requestId, templateId } });
    return waitJob(job, SUMMARY, hash, retryFailed);
  }
  async function openLive(onEvent, onClosed) {
    if (invalidated) throw unavailable('请重新连接盒子');
    const { info } = await requireCapability(LIVE);
    const lease = await call('/asr/sessions', { method: 'POST' });
    if (typeof lease.streamPath !== 'string' || !lease.streamPath.startsWith(PREFIX + '/')
      || !/^[A-Za-z0-9_./-]+$/.test(lease.streamPath) || lease.streamPath.includes('..')
      || typeof lease.ticket !== 'string' || !/^[A-Za-z0-9_.~-]{1,2048}$/.test(lease.ticket)) {
      throw new Error('实时字幕票据无效');
    }
    const { audio } = lease;
    if (audio?.encoding !== 'pcm_s16le' || audio.sampleRate !== 16000 || audio.channels !== 1) throw new Error('盒端实时音频格式不兼容');
    const maximum = lease.maxFrameBytes ?? info.maxFrameBytes;
    if (!Number.isSafeInteger(maximum) || maximum < 2 || maximum > 6400) throw new Error('实时帧长无效');
    const ws = await host.openStream(lease.streamPath, { protocols: ['wanx.asr.v1', 'wanx.asr.ticket.' + lease.ticket] });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('实时字幕连接超时')), 6000);
        const stop = () => { clearTimeout(timer); reject(new Error('实时字幕连接已中断')); };
        ws.on('close', () => { stop(); onClosed(); });
        ws.on('error', () => { stop(); onClosed(); });
        ws.on('message', (bytes, binary) => {
          if (binary) return;
          try {
            const event = JSON.parse(Buffer.from(bytes).toString('utf8'));
            if (event.type === 'ready') {
              clearTimeout(timer);
              if (ws.protocol !== 'wanx.asr.v1') reject(new Error('字幕协议协商失败'));
              else resolve();
            } else if (event.type === 'error') { stop(); onEvent(event); }
            else onEvent(event);
          } catch { /* 畸形事件不显示 */ }
        });
      });
    } catch (e) { ws.terminate(); throw e; }
    return {
      send(frame) {
        if (invalidated || ws.readyState !== 1 || !frame.length || frame.length > maximum || frame.length % 2) return false;
        ws.send(frame, { binary: true }, (err) => { if (err) onClosed(); });
        return true;
      },
      end() {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'end' }), {}, () => {});
        setTimeout(() => ws.terminate(), 1500).unref();
      }
    };
  }
  const status = async () => {
    try {
      const info = await capabilities();
      const ready = (id) => info.capabilities.some((c) => c.id === id && c.configured === true);
      return { mode, connected: mode === 'box', granted:info.capabilities.map(c => c.id), transcribe: ready(ASR), live: ready(LIVE), summarize: ready(SUMMARY), summaryLocation: info.capabilities.find(c => c.id === SUMMARY)?.processingLocation || info.processingLocation };
    } catch (e) { return { mode, connected: false, transcribe: false, live: false, summarize: false, reason: e.offline ? e.message : '盒子媒体能力暂不可用' }; }
  };
  const scope = async () => { await capabilities(); return ownerScope; };
  const usesCloudSummary = async () => (await requireCapability(SUMMARY)).info.processingLocation === 'cloud';
  return { mode, drive: host?.drive, scope, capabilities, requireCapability, usesCloudSummary, transcribe, summarize, ensureTemplate, openLive, status };
}

export let media = createMedia(null, null);
export function attachMedia(host) { media = createMedia(host, null); }

export function requireSample(sample) {
  if (sample) throw new HttpError(400, '请选择真实录音。');
}
