// 会议录音智能体 · 高管两栏桌面界面（纯 DOM 节点构建，严格遵循安全策略，零表情符号）
const MAX_PENDING_PCM = 24 * 1024 * 1024;
const LS_PREF = 'memoBoxRecording.preferredInput';
const PROJECT_ID = /^m-\d{8}-\d{6}-[0-9a-f]{6}$/;

const SCENARIO_COPY = {
  meeting: {
    id: 'meeting',
    name: '高管会议',
    short: '定论 · 责任期限 · 报价数字',
    briefTitle: '关注会议决策与待办',
    briefBody: '盒端可用时，参谋会在录音中提炼阶段小结，并在会后整理决策、负责人、期限与关键数字。',
    prePrompts: ['今天重点盯报价底线与付款账期', '散会报告请按负责人拆解待办与期限', '帮我留意各方对交付排期的分歧'],
    livePrompts: ['总结目前已拍板的定论', '还有哪些议题没定负责人？', '待会报告只保留核心数字和结论'],
    postPrompts: ['精简为 5 条核心拍板定论', '按负责人拆解待办与截止时间', '只保留涉及金额、报价与指标的内容', '改为正式对外合作纪要语气'],
  },
  training: {
    id: 'training',
    name: '培训讲座',
    short: '核心框架 · 案例数据 · 落地启发',
    briefTitle: '关注课程方法与案例',
    briefBody: '记录讲座和培训，整理方法、关键案例与可尝试的行动。',
    prePrompts: ['重点提炼讲师提到的客户转化率指标', '总结里请单独列出适合我们团队落地的3个动作'],
    livePrompts: ['提炼刚才这一段的核心框架', '讲师刚提到的标杆案例数据是多少？', '总结对我们业务有启发的部分'],
    postPrompts: ['提炼成一页高管速读精华卡片', '只保留核心方法论框架与关键数据', '结合讲座内容列出我司可落地的行动清单'],
  },
  chat: {
    id: 'chat',
    name: '日常交谈',
    short: '滤除寒暄 · 捕捉商机与承诺',
    briefTitle: '关注对话要点与承诺',
    briefBody: '记录客户拜访和日常交谈，提炼诉求、承诺和后续事项。',
    prePrompts: ['留意对方透露的明年预算规模与采购窗口', '帮我记下对方随口答应的引荐人脉与时间'],
    livePrompts: ['刚才聊天里有哪些有价值的商业信号？', '对方目前最核心的顾虑是什么？'],
    postPrompts: ['彻底去掉寒暄，只留高价值商业情报与承诺', '整理成客户拜访跟进备忘录', '提取需要下周跟进的线索与人脉'],
  },
};

const S = {
  boxReady: true,
  health: null,
  settings: null,
  catalog: null,
  allowCloudSummary: false,
  meetings: [],
  historyOpen: false,
  historyQuery: '',
  currentId: null,
  meeting: null,
  draftTitle: '',
  scenario: 'meeting',
  depth: 'standard',
  prefs: { remindUnresolved: true, checkMemory: false, autoCorrectTerms: true },
  preFocusNotes: [],
  devices: [],
  usb: null,
  permission: 'unknown',
  checkingMic: false,
  micError: '',
  selectedDeviceId: '',
  micOpen: false,
  micTest: null,
  starting: false,
  importing: false,
  rec: null,
  rightTab: 'report', // 'report' | 'advisor'
  editor: null,
  chatPending: false,
  draftBusy: false,
  transcriptQuery: '',
  flashSegIdx: null,
  audio: null, // { id, el, playing, currentMs, durationMs, rate }
  lastSig: '',
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'open') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

function svgIcon(name, size = 16) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const paths = {
    history: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'],
    plus: ['M12 5v14', 'M5 12h14'],
    mic: ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'],
    play: ['M6 4l14 8-14 8V4z'],
    pause: ['M6 4h4v16H6z', 'M14 4h4v16h-4z'],
    check: ['M20 6 9 17l-5-5'],
    spark: ['M12 3l1.9 5.8L20 10.8l-6.1 1.9L12 18.5l-1.9-5.8L4 10.8l6.1-1.9L12 3z'],
    upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
    close: ['M18 6 6 18', 'M6 6l12 12'],
    edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'],
  };
  for (const d of paths[name] || paths.spark) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    if (name === 'play' || name === 'pause') p.setAttribute('fill', 'currentColor');
    svg.append(p);
  }
  return svg;
}

function fmt(ms) {
  const t = Math.max(0, Math.floor((ms || 0) / 1000));
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3800);
}

async function api(urlPath, opts = {}) {
  const init = {
    method: opts.method || (opts.json !== undefined || opts.body !== undefined ? 'POST' : 'GET'),
    headers: { ...(opts.headers || {}) },
  };
  if (opts.json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
  } else if (opts.body !== undefined) {
    init.body = opts.body;
  }
  let r;
  try { r = await fetch(urlPath, init); } catch {
    const err = new Error('无法连接本机录音服务');
    err.network = true;
    throw err;
  }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json().catch(() => null) : await r.text();
  if (!r.ok) {
    const err = new Error((data && data.error) || `操作未完成（${r.status}）`);
    err.status = r.status;
    err.body = data;
    throw err;
  }
  return data;
}

// —— 设备与硬件检测 ——
const normalizedInput = (label) => (label || '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim().toLowerCase();
function detectedDisc() {
  const candidates = S.usb?.devices?.filter(
    (d) => d.manufacturer.toLowerCase() === 'timesintelli' && normalizedInput(d.name) === 'usb microphone v1.2',
  );
  return candidates?.length === 1 ? candidates[0] : null;
}
const deviceLabel = (id) => S.devices.find((d) => d.deviceId === id)?.label || '';

function preferredDeviceId() {
  const p = S.settings?.preferredInput;
  if (!p) return '';
  const d = S.devices.find((x) => p.deviceId && x.deviceId === p.deviceId)
    || S.devices.find((x) => p.label && x.label === p.label);
  return d ? d.deviceId : '';
}

function matchDisc() {
  const disc = detectedDisc();
  if (!disc || S.rec) return;
  const matches = S.devices.filter((d) => normalizedInput(d.label) === normalizedInput(disc.name));
  if (matches.length === 1 && !S.selectedDeviceId) S.selectedDeviceId = matches[0].deviceId;
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) { S.devices = []; return { added: [], removed: [] }; }
  const all = await navigator.mediaDevices.enumerateDevices();
  const ins = all.filter((d) => d.kind === 'audioinput' && d.label && !['default', 'communications'].includes(d.deviceId));
  if (ins.length) { S.permission = 'granted'; S.micError = ''; }
  const prev = new Map(S.devices.map((d) => [d.deviceId, d]));
  const next = ins.map((d) => ({ deviceId: d.deviceId, label: d.label }));
  const nextIds = new Set(next.map((d) => d.deviceId));
  const added = prev.size ? next.filter((d) => !prev.has(d.deviceId)) : [];
  const removed = [...prev.values()].filter((d) => !nextIds.has(d.deviceId));
  S.devices = next;
  if (S.selectedDeviceId && !nextIds.has(S.selectedDeviceId)) S.selectedDeviceId = '';
  if (!S.rec && !S.selectedDeviceId) {
    matchDisc();
    if (!S.selectedDeviceId) S.selectedDeviceId = preferredDeviceId() || next[0]?.deviceId || '';
  }
  return { added, removed };
}

async function checkPermission() {
  try {
    const st = await navigator.permissions?.query({ name: 'microphone' });
    if (st) {
      S.permission = st.state;
      st.onchange = () => { S.permission = st.state; refreshDevices().then(renderApp); };
    }
  } catch { /* ignore */ }
  await refreshDevices();
}

async function requestPermission() {
  if (S.checkingMic) return false;
  S.checkingMic = true;
  S.micError = '';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    await refreshDevices();
    S.permission = 'granted';
    if (!S.devices.length) S.micError = '已允许麦克风，但尚未检测到可用音频输入，请确认会议麦克风已连接。';
  } catch (e) {
    S.permission = e.name === 'NotAllowedError' ? 'denied' : 'unknown';
    S.micError = S.permission === 'denied'
      ? '请在系统设置「麦克风权限」中允许半人马AI-记忆盒子访问麦克风。'
      : '无法打开麦克风输入，请检查设备连接后重试。';
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    S.checkingMic = false;
  }
  if (S.micError) S.micOpen = true;
  renderApp();
  return !S.micError && S.devices.length > 0;
}

let scanningUsb = false;
async function updateUsb() {
  if (scanningUsb || !S.health?.desktop) return;
  scanningUsb = true;
  try {
    const next = await api('/api/usb-inputs');
    if (JSON.stringify(next) !== JSON.stringify(S.usb)) {
      S.usb = next;
      await refreshDevices();
      if (!S.currentId && !S.editor) renderApp();
    }
  } catch { /* fallback to browser enumerateDevices */ }
  finally { scanningUsb = false; }
}

async function savePreferredDevice(deviceId) {
  const label = deviceLabel(deviceId);
  if (!label) return;
  const pref = { deviceId, label };
  try { localStorage.setItem(LS_PREF, JSON.stringify(pref)); } catch { /* ignore */ }
  try { S.settings = await api('/api/settings', { method: 'PUT', json: { preferredInput: pref } }); } catch { /* ignore */ }
}

async function saveExecPrefs(partial) {
  S.prefs = { ...S.prefs, ...partial };
  try {
    S.settings = await api('/api/settings', {
      method: 'PUT',
      json: { executivePreferences: { defaultScenario: S.scenario, defaultDepth: S.depth, ...S.prefs } },
    });
  } catch { /* ignore */ }
}

async function approveCloudSummary(meeting) {
  if (!meeting || meeting.allowCloudSummary || S.health?.media?.summaryLocation !== 'cloud') return true;
  if (!window.confirm('盒子将把这份录音的转录和总结要求发送给已配置的云端模型。允许对这份录音使用云端总结吗？')) return false;
  const updated = await api(`/api/meetings/${meeting.id}`, { method: 'PATCH', json: { allowCloudSummary: true } });
  if (S.currentId === updated.id) S.meeting = updated;
  return true;
}

// —— 数据加载与轮询 ——
async function loadHealth() {
  const prev = JSON.stringify(S.health?.media);
  try { S.health = await api('/api/health'); } catch { S.health = null; }
  if (prev !== JSON.stringify(S.health?.media) && !S.editor) renderApp();
}

async function loadCatalog() {
  try {
    S.catalog = await api('/api/minutes-templates');
    if (S.catalog.executivePreferences) {
      const ep = S.catalog.executivePreferences;
      S.scenario = ep.defaultScenario || S.scenario;
      S.depth = ep.defaultDepth || S.depth;
      S.prefs = {
        remindUnresolved: ep.remindUnresolved !== false,
        checkMemory: false,
        autoCorrectTerms: ep.autoCorrectTerms !== false,
      };
    }
  } catch { /* ignore */ }
}

async function loadMeetings() {
  try {
    const { meetings } = await api('/api/meetings');
    S.meetings = meetings.filter((m) => m.source === 'disk');
  } catch { /* ignore */ }
}

function setHash(id, replace = false) {
  const hash = id ? `#${id}` : '';
  if (location.hash === hash) return;
  const url = location.pathname + hash;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}

async function selectMeeting(id, { replace = false } = {}) {
  if (id && S.rec && S.rec.meetingId !== id) {
    toast('请先结束当前正在进行的录音');
    return;
  }
  if (S.currentId !== id) {
    stopAudioPlayer();
    S.editor = null;
    S.rightTab = 'report';
    S.transcriptQuery = '';
    S.lastSig = '';
  }
  S.currentId = id;
  if (!id) S.allowCloudSummary = false;
  S.meeting = null;
  S.historyOpen = false;
  setHash(id, replace);
  renderApp();
  if (id) {
    try {
      const m = await api(`/api/meetings/${id}`);
      if (S.currentId !== id) return;
      if (m.source !== 'disk') throw new Error('该项目属于其他配件智能体');
      S.meeting = m;
      S.lastSig = meetingSig(m);
    } catch (e) {
      toast(e.message);
      S.currentId = null;
      setHash(null, true);
    }
    renderApp();
  } else {
    void loadMeetings();
  }
}

const meetingSig = (m) => JSON.stringify([
  m.state, m.audio?.status, m.transcript?.status, m.transcript?.segments?.length,
  m.rolling?.transcribedChunks, m.rolling?.segments?.length, m.rollingRunning,
  m.chapters?.length, m.advisorMessages?.length,
  m.minutes?.status, m.minutes?.rev, m.activeDraftId, m.drafts?.length,
  m.review?.status, m.review?.version, m.memory?.status, m.savedTo, m.pipelineRunning,
]);

let polling = false;
async function pollActiveMeeting() {
  if (polling || !S.currentId || S.editor) return;
  const m = S.meeting;
  const isLive = S.rec && S.rec.meetingId === S.currentId;
  const isBusy = m && (
    m.pipelineRunning || m.rollingRunning
    || ['pending', 'composing'].includes(m.audio?.status)
    || ['pending', 'running'].includes(m.transcript?.status)
    || ['pending', 'running'].includes(m.minutes?.status)
  );
  if (m && !isLive && !isBusy) return;
  polling = true;
  try {
    const fresh = await api(`/api/meetings/${S.currentId}`);
    if (fresh.id !== S.currentId) return;
    S.meeting = fresh;
    if (isLive) {
      updateLiveDom();
    } else if (meetingSig(fresh) !== S.lastSig) {
      S.lastSig = meetingSig(fresh);
      await loadMeetings();
      renderApp();
    }
  } catch { /* retry next tick */ }
  finally { polling = false; }
}

// —— Web Audio PCM 采集与流式字幕引擎 ——
async function openInput(deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const track = stream.getAudioTracks()[0];
  return { stream, track, deviceId, label: track.label || deviceLabel(deviceId) || '会议麦克风' };
}

async function testMicrophone() {
  if (!S.boxReady || S.micTest?.active || S.rec || S.starting || !S.selectedDeviceId) return;
  if (S.micTest?.url) URL.revokeObjectURL(S.micTest.url);
  const test = (S.micTest = { active: true, message: '正在本机试录 5 秒，请对着麦克风正常说话…', url: null, audio: null });
  S.micOpen = true;
  renderApp();
  let stream, ctx, monitor, timeout;
  try {
    const input = await openInput(S.selectedDeviceId);
    stream = input.stream;
    ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(analyser);
    await ctx.resume();
    const samples = new Float32Array(analyser.fftSize);
    let peak = 0;
    monitor = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      for (const v of samples) peak = Math.max(peak, Math.abs(v));
    }, 45);
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    const started = performance.now();
    await new Promise((resolve, reject) => {
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onerror = () => reject(new Error('拾音失败，请检查麦克风'));
      recorder.onstop = resolve;
      recorder.start();
      timeout = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, 5000);
    });
    if (!chunks.length || performance.now() - started < 4600 || input.track.readyState !== 'live') {
      throw new Error('试录被中断，请确认设备连接稳定');
    }
    test.url = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
    test.audio = new Audio(test.url);
    test.message = peak > 0.008
      ? `试录成功（峰值 ${Math.round(20 * Math.log10(peak))} dBFS），声音清晰。`
      : '试录完成，但音量极低，请确认麦克风未静音。';
  } catch (err) {
    test.message = `试录未通过：${err.message}`;
  } finally {
    clearInterval(monitor);
    clearTimeout(timeout);
    stream?.getTracks().forEach((t) => t.stop());
    if (ctx) await ctx.close().catch(() => {});
    test.active = false;
    if (!S.currentId) renderApp();
  }
}

const elapsed = (rec) => rec.baseMs + rec.activeMs + (rec.state === 'recording' ? performance.now() - rec.resumedAt : 0);

function releaseStream(rec) {
  try { rec.audioNode?.disconnect(); } catch { /* ignore */ }
  rec.stream?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  rec.audioNode = null;
  rec.stream = null;
  rec.track = null;
}

function pauseCapture(rec) {
  if (rec.state !== 'recording') return;
  rec.node?.port.postMessage({ type: 'pause' });
  rec.activeMs += performance.now() - rec.resumedAt;
  rec.state = 'paused';
}

function onTrackEnded(rec, track) {
  if (rec.track !== track || S.rec !== rec) return;
  const label = rec.deviceLabel;
  pauseCapture(rec);
  releaseStream(rec);
  rec.deviceLost = label;
  S.selectedDeviceId = '';
  rec.notice = `麦克风「${label}」已断开，录音已自动暂停并完整保护已录片段。请重新插好或选择麦克风后继续，或直接结束录音。`;
  refreshDevices().then(() => { S.selectedDeviceId = ''; renderApp(); });
}

function attachStream(rec, inp) {
  rec.stream = inp.stream;
  rec.track = inp.track;
  rec.deviceId = inp.deviceId;
  rec.deviceLabel = inp.label;
  rec.deviceLost = null;
  rec.audioNode = rec.ctx.createMediaStreamSource(inp.stream);
  rec.audioNode.connect(rec.node);
  const track = inp.track;
  track.onended = () => onTrackEnded(rec, track);
  if (!rec.inputs.includes(inp.label)) rec.inputs.push(inp.label);
}

function onWorkletMsg(rec, d) {
  if (!d) return;
  if (d.type === 'chunk') {
    const seq = rec.nextSeq++;
    rec.queue.push({ seq, pcm: d.pcm, fail: 0 });
    rec.pendingBytes += d.pcm.byteLength;
    if (rec.state === 'recording' && rec.pendingBytes >= MAX_PENDING_PCM) {
      pauseCapture(rec);
      rec.notice = '待落盘音频较多，已自动暂停保护原音，稍候保存完成后可继续。';
      renderApp();
    }
    void pumpUploads(rec);
  } else if (d.type === 'frame') {
    if (S.health?.media?.live && !rec.liveSending) {
      rec.liveSending = true;
      void api(`/api/meetings/${rec.meetingId}/live`, {
        body: d.pcm,
        headers: { 'content-type': 'application/octet-stream' },
      }).catch(() => {}).finally(() => { rec.liveSending = false; });
    }
  } else if (d.type === 'level') {
    rec.levels.push(d.active && rec.state === 'recording' ? d.rms : 0);
    if (rec.levels.length > 80) rec.levels.shift();
    rec.peak = Math.max(d.peak, (rec.peak || 0) * 0.9);
    rec.rms = d.rms;
  } else if (d.type === 'flushed') {
    const w = rec.flushWaiters.get(d.id);
    if (w) w();
  }
}

async function pumpUploads(rec) {
  if (rec.uploading) return;
  rec.uploading = true;
  try {
    while (rec.queue.length && !rec.aborted) {
      const c = rec.queue[0];
      try {
        const r = await api(`/api/meetings/${rec.meetingId}/chunks?seq=${c.seq}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: c.pcm,
        });
        rec.queue.shift();
        rec.pendingBytes -= c.pcm.byteLength;
        rec.saved = r.savedChunks;
        rec.uploadError = '';
      } catch (e) {
        if (e.status && e.status < 500 && ![408, 429].includes(e.status)) {
          rec.uploadError = `音频片 ${c.seq} 保存异常：${e.message}`;
          rec.uploadFatal = true;
          break;
        }
        c.fail++;
        rec.uploadError = `正在重试本机保存（${e.message}）`;
        await sleep(Math.min(12000, 500 * 2 ** c.fail));
      }
    }
  } finally {
    rec.uploading = false;
  }
}

function flushWorklet(rec) {
  return new Promise((resolve) => {
    if (!rec.node) return resolve();
    const id = ++rec.flushId;
    const done = () => { rec.flushWaiters.delete(id); resolve(); };
    rec.flushWaiters.set(id, done);
    rec.node.port.postMessage({ type: 'flush', id });
    setTimeout(done, 2000);
  });
}

async function startRecording(existing = null) {
  if (!S.boxReady || S.starting || S.importing) return;
  if ((!S.devices.length || S.permission !== 'granted') && !(await requestPermission())) return;
  if (!S.selectedDeviceId) {
    S.micOpen = true;
    renderApp();
    toast('请先确认拾音麦克风');
    return;
  }
  S.starting = true;
  renderApp();
  let inp, context;
  try {
    inp = await openInput(S.selectedDeviceId);
    const options = { latencyHint: 'interactive' };
    if (existing?.sampleRate) options.sampleRate = existing.sampleRate;
    context = new AudioContext(options);
    const channels = inp.track.getSettings().channelCount || existing?.channels || 1;
    let m = existing;
    if (!m) {
      m = await api('/api/meetings', {
        json: {
          title: S.draftTitle.trim(),
          source: 'disk',
          scenario: S.scenario,
          depth: S.depth,
          preferences: S.prefs,
          focusNotes: S.preFocusNotes,
          allowCloudSummary: S.health?.media?.summaryLocation === 'cloud' && S.allowCloudSummary,
          inputLabel: inp.label,
          sampleRate: context.sampleRate,
          channels,
        },
      });
    }
    const rec = {
      meetingId: m.id,
      source: 'disk',
      deviceLabel: inp.label,
      state: 'recording',
      nextSeq: m.chunks.length,
      saved: m.chunks.length,
      channels: m.channels || 1,
      pendingBytes: 0,
      queue: [],
      uploading: false,
      uploadError: '',
      uploadFatal: false,
      aborted: false,
      levels: [],
      peak: 0,
      rms: 0,
      flushId: 0,
      flushWaiters: new Map(),
      inputs: [],
      baseMs: m.durationMs || 0,
      activeMs: 0,
      resumedAt: performance.now(),
      notice: '',
      deviceLost: null,
      ctx: context,
    };
    await context.audioWorklet.addModule('/pcm-worklet.js');
    rec.node = new AudioWorkletNode(context, 'pcm16k', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: rec.channels, channelCountMode: 'explicit', channelInterpretation: 'discrete',
      processorOptions: { channels: rec.channels, live: true },
    });
    rec.sink = context.createGain();
    rec.sink.gain.value = 0;
    rec.node.connect(rec.sink).connect(context.destination);
    rec.node.port.onmessage = (e) => onWorkletMsg(rec, e.data);
    if (context.state === 'suspended') await context.resume();
    attachStream(rec, inp);
    rec.node.port.postMessage({ type: 'resume' });
    void savePreferredDevice(S.selectedDeviceId);

    S.rec = rec;
    S.draftTitle = '';
    S.preFocusNotes = [];
    S.currentId = m.id;
    S.meeting = m;
    setHash(m.id);
    await loadMeetings();
  } catch (e) {
    inp?.stream?.getTracks().forEach((t) => t.stop());
    await context?.close().catch(() => {});
    toast(`未能开启录音：${e.message}`);
  } finally {
    S.starting = false;
    renderApp();
  }
}

async function resumeRecording() {
  const rec = S.rec;
  if (!S.boxReady || !rec || rec.boxInterrupted || rec.state !== 'paused') return;
  if (!S.selectedDeviceId) { toast('请选择麦克风后继续'); return; }
  try {
    if (!rec.track || rec.track.readyState === 'ended' || rec.deviceId !== S.selectedDeviceId) {
      const inp = await openInput(S.selectedDeviceId);
      releaseStream(rec);
      attachStream(rec, inp);
    }
    if (rec.ctx.state === 'suspended') await rec.ctx.resume();
    rec.node.port.postMessage({ type: 'resume' });
    rec.state = 'recording';
    rec.resumedAt = performance.now();
    rec.notice = '';
    renderApp();
  } catch (e) {
    toast(`无法恢复麦克风：${e.message}`);
  }
}

async function finishRecording() {
  const rec = S.rec;
  if (!rec || rec.state === 'finishing') return;
  pauseCapture(rec);
  rec.state = 'finishing';
  renderApp();
  await flushWorklet(rec);
  const deadline = Date.now() + 90000;
  while (rec.queue.length) {
    if (rec.uploadFatal || Date.now() > deadline) {
      rec.state = 'paused';
      rec.uploadFatal = false;
      rec.notice = '仍有少量原音片段正在写入本机，请再点一次「结束并提炼报告」。';
      renderApp();
      return;
    }
    void pumpUploads(rec);
    await sleep(180);
  }
  try {
    const audioOnly = rec.boxInterrupted || !S.boxReady;
    const m = await api(`/api/meetings/${rec.meetingId}/finish`, {
      json: { chunkCount: rec.nextSeq, ...(audioOnly ? { audioOnly: true } : {}) },
    });
    rec.aborted = true;
    releaseStream(rec);
    try { rec.node?.disconnect(); } catch { /* ignore */ }
    await rec.ctx?.close().catch(() => {});
    S.rec = null;
    S.meeting = m;
    S.rightTab = 'report';
    S.lastSig = '';
    toast(audioOnly || !S.health?.media?.transcribe ? '录音已保存到本机' : '录音已结束，正在处理转录');
    await loadMeetings();
    renderApp();
  } catch (e) {
    rec.state = 'paused';
    rec.notice = `结束异常：${e.message}`;
    renderApp();
  }
}

async function importAudioFile(file) {
  if (!S.boxReady || S.importing || S.starting || S.rec) return;
  S.importing = true;
  renderApp();
  try {
    const params = new URLSearchParams({ name: file.name, scenario: S.scenario,
      allowCloudSummary: String(S.health?.media?.summaryLocation === 'cloud' && S.allowCloudSummary) });
    const saved = await api('/api/import-audio?' + params.toString(), {
      method: 'POST',
      body: file,
      headers: { 'content-type': 'application/octet-stream' },
    });
    await loadMeetings();
    await selectMeeting(saved.id);
    toast('已导入录音');
  } catch (e) {
    toast(e.message);
  } finally {
    S.importing = false;
    if (!S.currentId) renderApp();
  }
}

// —— 定制音频回放器（无原生浏览器丑陋控件） ——
function ensureAudioPlayer(m) {
  if (m?.audio?.status !== 'saved') return null;
  if (!S.audio || S.audio.id !== m.id) {
    stopAudioPlayer();
    const el = new Audio(`/api/meetings/${m.id}/audio`);
    el.preload = 'metadata';
    const state = { id: m.id, el, playing: false, currentMs: 0, durationMs: m.durationMs || 0, rate: 1 };
    el.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(el.duration) && el.duration > 0) state.durationMs = Math.round(el.duration * 1000);
      syncPlayerDom();
    });
    el.addEventListener('timeupdate', () => {
      state.currentMs = Math.round(el.currentTime * 1000);
      syncPlayerDom();
    });
    el.addEventListener('play', () => { state.playing = true; syncPlayerDom(); });
    el.addEventListener('pause', () => { state.playing = false; syncPlayerDom(); });
    el.addEventListener('ended', () => { state.playing = false; syncPlayerDom(); });
    S.audio = state;
  }
  return S.audio;
}

function stopAudioPlayer() {
  if (S.audio?.el) {
    S.audio.el.pause();
    S.audio.el.src = '';
  }
  S.audio = null;
}

function seekAndPlay(ms, segIdx = null) {
  const m = S.meeting;
  if (!m) return;
  const player = ensureAudioPlayer(m);
  const segs = m.transcript?.segments || [];
  const targetSeg = (segIdx !== null && segs.find((s) => s.i === segIdx))
    || segs.find((s) => ms >= s.fromMs && ms < s.toMs)
    || segs.find((s) => s.fromMs >= ms);
  if (targetSeg) {
    S.flashSegIdx = targetSeg.i;
    const row = document.querySelector(`[data-ed-seg="${targetSeg.i}"]`);
    if (row) {
      row.hidden = false;
      row.classList.add('flash');
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => row.classList.remove('flash'), 2000);
    }
  }
  if (!player) {
    toast('原始音频正在准备中');
    return;
  }
  player.el.currentTime = Math.max(0, ms / 1000);
  player.el.play().catch(() => {});
}

function syncPlayerDom() {
  const p = S.audio;
  if (!p) return;
  const btn = $('edPlayBtn');
  if (btn) {
    btn.replaceChildren(svgIcon(p.playing ? 'pause' : 'play', 18));
    btn.setAttribute('aria-label', p.playing ? '暂停播放' : '播放原音');
  }
  const range = $('edScrubber');
  const total = Math.max(p.durationMs || 1, p.currentMs);
  if (range && document.activeElement !== range) {
    range.max = String(total);
    range.value = String(p.currentMs);
  }
  const time = $('edPlayerTime');
  if (time) time.textContent = `${fmt(p.currentMs)} / ${fmt(total)}`;
  document.querySelectorAll('[data-ed-seg]').forEach((row) => {
    const f = Number(row.dataset.from || 0);
    const t = Number(row.dataset.to || 0);
    row.classList.toggle('playing', p.playing && p.currentMs >= f && p.currentMs < t);
  });
}

// —— 对话框：发言人改名、同音词还原、保存个人模板、管理专有词 ——
function openDialog(buildFn) {
  const root = $('modalRoot');
  root.replaceChildren();
  const dlg = h('dialog', { class: 'ed-dialog', onclose: () => dlg.remove() });
  dlg.append(buildFn(dlg));
  root.append(dlg);
  dlg.showModal();
}

function promptRenameSpeaker(spkId, currentLabel) {
  openDialog((dlg) => {
    const input = h('input', { class: 'ed-title-input', type: 'text', value: currentLabel, maxlength: 24, placeholder: '如：王总、李总监、客户张总' });
    setTimeout(() => { input.focus(); input.select(); }, 30);
    return h('form', {
      class: 'ed-dialog-inner',
      onsubmit: async (e) => {
        e.preventDefault();
        const label = input.value.trim();
        if (!label) return;
        try {
          S.meeting = await api(`/api/meetings/${S.currentId}/speakers/${spkId}`, { method: 'PUT', json: { label } });
          dlg.close();
          renderApp();
          toast(`已将发言人标记为「${label}」`);
        } catch (err) { toast(err.message); }
      },
    },
    h('h3', null, '修改发言人称呼'),
    h('p', { class: 'ed-col-sub' }, '发言归属由停顿和上下文推测，请先回听核对。修改会应用到本场同一标签的段落。'),
    input,
    h('div', { class: 'ed-dialog-actions' },
      h('button', { class: 'ed-btn', type: 'button', onclick: () => dlg.close() }, '取消'),
      h('button', { class: 'ed-btn primary', type: 'submit' }, '确认修改')));
  });
}

function promptRevertTerm(segIdx, corr) {
  openDialog((dlg) => h('div', { class: 'ed-dialog-inner' },
    h('h3', null, '专有名词静默修正核对'),
    h('p', null, `参谋已将语音识别原词「${corr.from}」静默修正为「${corr.to}」。如果原话确实说的是「${corr.from}」，可一键恢复。`),
    h('div', { class: 'ed-dialog-actions' },
      h('button', { class: 'ed-btn', type: 'button', onclick: () => dlg.close() }, '保留修正词'),
      h('button', {
        class: 'ed-btn primary', type: 'button',
        onclick: async () => {
          try {
            S.meeting = await api(`/api/meetings/${S.currentId}/segments/${segIdx}/revert`, { json: corr });
            dlg.close();
            renderApp();
            toast(`已恢复为原词「${corr.from}」`);
          } catch (err) { toast(err.message); }
        },
      }, `恢复为「${corr.from}」`))));
}

function promptCustomTerms() {
  const existing = S.settings?.executivePreferences?.customTerms || [];
  const initialLines = existing.map((t) => (t.wrong ? `${t.wrong}=${t.right}` : t.right)).join('\n');
  openDialog((dlg) => {
    const area = h('textarea', {
      class: 'ed-editor-textarea',
      rows: 6,
      value: initialLines,
      placeholder: '每行一个常用词或纠错对，例如：\n半人马AI\n华东大区\n王建国=王建国总\n万像=万象',
    });
    return h('form', {
      class: 'ed-dialog-inner',
      onsubmit: async (e) => {
        e.preventDefault();
        const terms = area.value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
          const eq = line.indexOf('=');
          return eq > 0
            ? { wrong: line.slice(0, eq).trim(), right: line.slice(eq + 1).trim() }
            : { wrong: '', right: line };
        });
        try {
          S.settings = await api('/api/settings', {
            method: 'PUT',
            json: { executivePreferences: { ...S.prefs, defaultScenario: S.scenario, defaultDepth: S.depth, customTerms: terms } },
          });
          dlg.close();
          toast('常用专有名词表已更新');
        } catch (err) { toast(err.message); }
      },
    },
    h('h3', null, '管理公司与客户常用名词'),
    h('p', { class: 'ed-col-sub' }, '录入高管姓名、客户简称或产品词后，参谋在录音中会自动静默纠偏同音错字。'),
    area,
    h('div', { class: 'ed-dialog-actions' },
      h('button', { class: 'ed-btn', type: 'button', onclick: () => dlg.close() }, '取消'),
      h('button', { class: 'ed-btn primary', type: 'submit' }, '保存词表')));
  });
}

function promptSaveAsTemplate(m) {
  const activeDraft = m.drafts?.find((d) => d.id === m.activeDraftId);
  const baseRules = [
    m.minutes?.template?.rules || '',
    activeDraft?.instruction ? `补充要求：${activeDraft.instruction}` : '',
  ].filter(Boolean).join('\n');
  openDialog((dlg) => {
    const nameInput = h('input', { class: 'ed-title-input', type: 'text', maxlength: 36, placeholder: '如：周度经营例会简报', required: true });
    const rulesInput = h('textarea', { class: 'ed-editor-textarea', rows: 5, value: baseRules, maxlength: 2000, required: true });
    return h('form', {
      class: 'ed-dialog-inner',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const res = await api('/api/minutes-templates', {
            method: 'PUT',
            json: { name: nameInput.value.trim(), rules: rulesInput.value.trim(), scenario: m.scenario },
          });
          S.catalog = res;
          dlg.close();
          renderApp();
          toast('已存为您的个人常用模板');
        } catch (err) { toast(err.message); }
      },
    },
    h('h3', null, '存为我的常用报告模板'),
    h('p', { class: 'ed-col-sub' }, '保存后，今后任何录音都可在报告上方一键套用这套提炼风格。'),
    nameInput,
    rulesInput,
    h('div', { class: 'ed-dialog-actions' },
      h('button', { class: 'ed-btn', type: 'button', onclick: () => dlg.close() }, '取消'),
      h('button', { class: 'ed-btn primary', type: 'submit' }, '保存模板')));
  });
}

// —— 参谋交互与报告切换 ——
async function sendAdvisorMessage(text) {
  const msg = (text || '').trim();
  if (!msg || S.chatPending) return;

  // 会前尚未开始录音：记入本场关注重点
  if (!S.currentId) {
    if (!S.preFocusNotes.includes(msg)) S.preFocusNotes.push(msg);
    renderApp();
    toast('已记入本场参谋关注重点');
    return;
  }

  S.chatPending = true;
  if (S.meeting?.state === 'recording') S.rightTab = 'advisor';
  renderApp();
  try {
    if (!(await approveCloudSummary(S.meeting))) return;
    const updated = await api(`/api/meetings/${S.currentId}/advisor-chat`, { json: { message: msg } });
    if (S.currentId === updated.id) {
      const prevDraftId = S.meeting?.activeDraftId;
      S.meeting = updated;
      S.lastSig = meetingSig(updated);
      if (updated.state === 'finished' && updated.activeDraftId && updated.activeDraftId !== prevDraftId) {
        S.rightTab = 'report';
        toast('参谋已按您的要求更新有效信息报告');
      }
    }
  } catch (e) {
    toast(e.message);
  } finally {
    S.chatPending = false;
    renderApp();
  }
}

async function switchReportVariant({ templateId, depth }) {
  if (!S.currentId || S.draftBusy) return;
  S.draftBusy = true;
  renderApp();
  try {
    if (!(await approveCloudSummary(S.meeting))) return;
    const updated = await api(`/api/meetings/${S.currentId}/drafts`, { json: { templateId, depth } });
    if (S.currentId === updated.id) {
      S.meeting = updated;
      S.lastSig = meetingSig(updated);
    }
  } catch (e) {
    toast(e.message);
  } finally {
    S.draftBusy = false;
    renderApp();
  }
}

async function activateSavedDraft(draftId) {
  if (!S.currentId || S.draftBusy) return;
  S.draftBusy = true;
  try {
    const updated = await api(`/api/meetings/${S.currentId}/drafts/${draftId}/activate`, { json: {} });
    if (S.currentId === updated.id) {
      S.meeting = updated;
      S.lastSig = meetingSig(updated);
    }
  } catch (e) {
    toast(e.message);
  } finally {
    S.draftBusy = false;
    renderApp();
  }
}

// —— 片段文本渲染（支持同音修正词虚线高亮点击还原） ——
function renderSegmentTextNodes(seg) {
  const text = seg.text || '';
  const corrs = Array.isArray(seg.corrections) ? seg.corrections.filter((c) => c.to && text.includes(c.to)) : [];
  if (!corrs.length) return [text];
  const corr = corrs[0];
  const parts = text.split(corr.to);
  const out = [];
  parts.forEach((part, idx) => {
    if (part) out.push(part);
    if (idx < parts.length - 1) {
      out.push(h('button', {
        class: 'ed-corrected-term',
        type: 'button',
        title: `原识别词「${corr.from}」，点击可恢复`,
        onclick: () => promptRevertTerm(seg.i, corr),
      }, corr.to));
    }
  });
  return out;
}

// —— 界面主渲染 ——
let liveDomRefs = null;

function renderTopBar() {
  const disc = detectedDisc();
  const micName = disc ? `会议定向麦已就绪 · ${disc.name}` : (deviceLabel(S.selectedDeviceId) || '待选择麦克风');
  const media = S.health?.media;
  const mediaReady = Boolean(media?.transcribe && media?.summarize);

  return h('header', { class: 'ed-topbar' },
    h('div', { class: 'ed-topbar-left' },
      h('div', { class: 'ed-brand-title' },
        h('img', { src: '/disk-agent.svg', width: 38, height: 38, alt: '' }),
        h('strong', null, '会议录音智能体'))),
    h('div', { class: 'ed-topbar-right' },
      h('span', { class: 'ed-status-pill', 'data-ready': String(Boolean(disc || S.selectedDeviceId)) },
        h('span', { class: 'ed-status-dot' }), micName),
      h('span', { class: 'ed-status-pill', 'data-ready': String(mediaReady) },
        h('span', { class: 'ed-status-dot' }),
        mediaReady ? '盒端已就绪' : media?.transcribe ? '盒端转写可用' : '本机录音'),
      h('button', { class: 'ed-top-btn', type: 'button',
        onclick: () => { S.historyOpen = true; renderDrawer(); } }, svgIcon('history', 16), '录音历史'),
      S.currentId ? h('button', { class: 'ed-top-btn primary-subtle', type: 'button',
        disabled: Boolean(S.rec || S.starting), onclick: () => selectMeeting(null) },
        svgIcon('plus', 15), '新建录音') : null));
}

function renderLeftSetup() {
  const disc = detectedDisc();
  const currentMicText = deviceLabel(S.selectedDeviceId) || disc?.name || '点击展开选择';
  const fileInput = h('input', {
    type: 'file',
    hidden: true,
    accept: 'audio/*,.wav,.mp3,.m4a,.flac,.ogg,.aac,.webm',
    onchange: (e) => {
      const f = e.target.files?.[0];
      if (f) void importAudioFile(f);
      e.target.value = '';
    },
  });

  return h('section', { class: 'ed-col', 'aria-label': '录音机与会前设置' },
    h('div', { class: 'ed-col-header' },
      h('h2', null, svgIcon('mic', 18), '新建录音'),
      h('span', { class: 'ed-col-sub' }, '原音保存在本机')),
    h('div', { class: 'ed-scroll-body ed-setup-stack' },
      h('div', { class: 'ed-field-block' },
        h('label', { class: 'ed-section-label', for: 'edTitleInput' }, '录音主题（选填）'),
        h('input', {
          id: 'edTitleInput',
          class: 'ed-title-input',
          type: 'text',
          maxlength: 80,
          value: S.draftTitle,
          placeholder: '例如：产品周会',
          oninput: (e) => { S.draftTitle = e.target.value; },
        })),
      h('div', { class: 'ed-field-block' },
        h('span', { class: 'ed-section-label' }, '录音场景'),
        h('div', { class: 'ed-scenario-grid', role: 'radiogroup', 'aria-label': '记录场景' },
          Object.values(SCENARIO_COPY).map((sc) => h('button', {
            class: 'ed-scenario-card',
            type: 'button',
            role: 'radio',
            'aria-checked': String(S.scenario === sc.id),
            onclick: () => {
              S.scenario = sc.id;
              void saveExecPrefs({});
              renderApp();
            },
          }, h('strong', null, sc.name), h('span', null, sc.short))))),
      h('div', { class: 'ed-field-block' },
        h('div', { class: 'ed-section-label' },
          h('span', null, '参谋偏好'),
          h('button', { class: 'ed-link-btn', type: 'button', onclick: promptCustomTerms }, '管理常用专有名词')),
        h('div', { class: 'ed-pref-list' },
          h('div', { class: 'ed-pref-item' },
            h('label', { class: 'ed-pref-label' },
              h('input', {
                type: 'checkbox',
                checked: S.prefs.remindUnresolved,
                onchange: (e) => saveExecPrefs({ remindUnresolved: e.target.checked }),
              }),
              '提醒未决议题和缺少负责人的待办')),
          h('div', { class: 'ed-pref-item' },
            h('label', { class: 'ed-pref-label' },
              h('input', {
                type: 'checkbox',
                checked: S.prefs.autoCorrectTerms,
                onchange: (e) => saveExecPrefs({ autoCorrectTerms: e.target.checked }),
              }),
              '根据词表校正专有名词')),
          S.health?.media?.summaryLocation === 'cloud' ? h('div', { class: 'ed-pref-item' },
            h('label', { class: 'ed-pref-label' },
              h('input', { type: 'checkbox', checked: S.allowCloudSummary,
                onchange: (event) => { S.allowCloudSummary = event.target.checked; } }),
              '允许本次转录发送到已配置的云端总结模型')) : null)),
      h('details', {
        class: 'ed-mic-box',
        open: S.micOpen || Boolean(S.micError) || !S.selectedDeviceId,
        ontoggle: (e) => { if (e.target.isConnected) S.micOpen = e.target.open; },
      },
      h('summary', null, h('span', null, '麦克风与试音'), h('span', { class: 'ed-mic-current' }, currentMicText)),
      h('div', { class: 'ed-mic-body' },
        S.permission !== 'granted' || !S.devices.length
          ? h('div', { class: 'ed-mic-row' },
            h('span', { class: 'ed-col-sub' }, S.micError || '首次使用请允许麦克风权限以连接定向麦克风'),
            h('button', { class: 'ed-btn', type: 'button', disabled: S.checkingMic, onclick: requestPermission }, S.micError ? '重新检测' : '允许麦克风'))
          : h('div', { class: 'ed-mic-row' },
            h('select', {
              class: 'ed-select',
              'aria-label': '选择拾音麦克风',
              disabled: Boolean(S.micTest?.active),
              onchange: (e) => {
                S.selectedDeviceId = e.target.value;
                void savePreferredDevice(S.selectedDeviceId);
                renderApp();
              },
            }, S.devices.map((d) => h('option', { value: d.deviceId, selected: d.deviceId === S.selectedDeviceId }, d.label))),
            h('button', { class: 'ed-btn', type: 'button', onclick: () => refreshDevices().then(renderApp) }, '刷新'),
            h('button', {
              class: 'ed-btn',
              type: 'button',
              disabled: Boolean(S.micTest?.active || !S.selectedDeviceId),
              onclick: testMicrophone,
            }, S.micTest?.active ? '正在试录…' : '试录 5 秒')),
        S.micTest?.message ? h('div', { class: 'ed-mic-row' },
          h('span', { class: 'ed-col-sub' }, S.micTest.message),
          S.micTest.audio ? h('button', {
            class: 'ed-btn',
            type: 'button',
            onclick: () => { S.micTest.audio.currentTime = 0; S.micTest.audio.play().catch(() => {}); },
          }, svgIcon('play', 14), '回听试音') : null) : null))),
    h('div', { class: 'ed-action-footer' },
      fileInput,
      h('button', {
        class: 'ed-record-cta',
        type: 'button',
        disabled: S.starting || S.importing || Boolean(S.micTest?.active),
        onclick: () => startRecording(null),
      }, h('span', { class: 'ed-record-dot-icon' }), S.starting ? '正在启动录音仪…' : '开始录音'),
      h('button', {
        class: 'ed-secondary-cta',
        type: 'button',
        disabled: S.starting || S.importing,
        onclick: () => fileInput.click(),
      }, svgIcon('upload', 16), S.importing ? '导入中…' : '导入录音文件')));
}

function renderRightSetup() {
  const sc = SCENARIO_COPY[S.scenario] || SCENARIO_COPY.meeting;
  const chatInput = h('input', {
    class: 'ed-chat-input',
    type: 'text',
    placeholder: '输入希望参谋关注的事项',
  });

  return h('section', { class: 'ed-col', 'aria-label': 'AI 随身参谋' },
    h('div', { class: 'ed-col-header' },
      h('h2', null, svgIcon('spark', 18), 'AI 随身参谋'),
      h('span', { class: 'ed-col-sub' }, `当前模式：${sc.name}`)),
    h('div', { class: 'ed-advisor-stream' },
      h('div', { class: 'ed-briefing-card' },
        h('h3', null, sc.briefTitle),
        h('p', null, sc.briefBody)),
      S.preFocusNotes.length ? h('div', { class: 'ed-focus-box' },
        h('span', { class: 'ed-section-label' }, '本场已设定的重点关注事项（将在提炼报告中优先呈现）'),
        h('div', { class: 'ed-focus-tags' },
          S.preFocusNotes.map((note, idx) => h('span', { class: 'ed-focus-tag' },
            note,
            h('button', {
              type: 'button',
              'aria-label': '移除',
              onclick: () => { S.preFocusNotes.splice(idx, 1); renderApp(); },
            }, '×'))))) : null),
    h('div', { class: 'ed-copilot-bar' },
      h('div', { class: 'ed-quick-prompts' },
        sc.prePrompts.map((p) => h('button', {
          class: 'ed-quick-pill',
          type: 'button',
          onclick: () => sendAdvisorMessage(p),
        }, p))),
      h('form', {
        class: 'ed-chat-form',
        onsubmit: (e) => {
          e.preventDefault();
          const v = chatInput.value;
          chatInput.value = '';
          void sendAdvisorMessage(v);
        },
      }, chatInput, h('button', { class: 'ed-chat-send', type: 'submit' }, '叮嘱参谋'))));
}

function renderLeftLive(m) {
  const rec = S.rec;
  // 未正常结束的历史录音恢复视图
  if (!rec || rec.meetingId !== m.id) {
    return h('section', { class: 'ed-col' },
      h('div', { class: 'ed-col-header' }, h('h2', null, m.title), h('span', { class: 'ed-col-sub' }, '录音待收尾')),
      h('div', { class: 'ed-scroll-body ed-setup-stack' },
        h('div', { class: 'ed-notice-banner' },
          `本场录音上次未按结束键收尾，已安全保存 ${m.chunks.length} 个原音片段（共 ${fmt(m.durationMs)}）。您可以继续接着录，或直接结束并生成有效信息报告。`),
        h('div', { class: 'ed-mic-row' },
          h('button', { class: 'ed-btn', type: 'button', onclick: () => startRecording(m) }, '接着继续录音'),
          h('button', {
            class: 'ed-btn primary',
            type: 'button',
            onclick: async () => {
              try {
                S.meeting = await api(`/api/meetings/${m.id}/finish`, { json: {} });
                await loadMeetings();
                renderApp();
              } catch (e) { toast(e.message); }
            },
          }, '结束录音并提炼有效信息报告'))));
  }

  const paused = rec.state !== 'recording';
  const sc = SCENARIO_COPY[m.scenario] || SCENARIO_COPY.meeting;
  const timerEl = h('span', { class: 'ed-clock' }, fmt(elapsed(rec)));
  const waveEl = h('canvas', { class: 'ed-wave-canvas', width: '640', height: '108', 'aria-label': '实时拾音波形' });
  const statusEl = h('span', { class: 'ed-deck-status' }, paused ? '录音已暂停' : '正在清晰拾音 · 本机实时落盘');
  const listEl = h('div', { class: 'ed-transcript-list', 'aria-live': 'polite' });

  liveDomRefs = { timerEl, waveEl, statusEl, listEl, sig: '' };

  const col = h('section', { class: 'ed-col', 'aria-label': '录音现场与实时原话' },
    h('div', { class: 'ed-live-deck' },
      h('div', { class: 'ed-deck-top' },
        h('span', { class: 'ed-deck-title', title: m.title }, m.title),
        h('span', { class: 'ed-deck-tag' }, sc.name)),
      h('div', { class: 'ed-deck-meter' },
        h('div', { class: 'ed-clock-wrap' },
          h('span', { class: `ed-rec-lamp ${paused ? 'paused' : ''}` }),
          timerEl),
        waveEl),
      rec.notice ? h('div', { class: 'ed-notice-banner error' }, rec.notice) : null,
      paused && rec.deviceLost ? h('div', { class: 'ed-mic-row' },
        h('select', {
          class: 'ed-select',
          onchange: (e) => { S.selectedDeviceId = e.target.value; renderApp(); },
        }, h('option', { value: '' }, '请选择恢复使用的麦克风'),
        S.devices.map((d) => h('option', { value: d.deviceId, selected: d.deviceId === S.selectedDeviceId }, d.label)))) : null,
      h('div', { class: 'ed-deck-bottom' },
        statusEl,
        h('div', { class: 'ed-deck-actions' },
          rec.state === 'recording'
            ? h('button', { class: 'ed-deck-btn', type: 'button', onclick: () => { pauseCapture(rec); renderApp(); } }, '暂停')
            : h('button', { class: 'ed-deck-btn', type: 'button', disabled: rec.state === 'finishing', onclick: resumeRecording }, '继续录音'),
          h('button', {
            class: 'ed-deck-btn finish',
            type: 'button',
            disabled: rec.state === 'finishing',
            onclick: finishRecording,
          }, rec.state === 'finishing' ? '正在封存原音…' : '结束并提炼报告')))),
    h('div', { class: 'ed-transcript-bar' },
      h('span', null, '实时原话记录（点击人名可改称呼，虚线词可一键恢复原词）')),
    listEl);

  updateLiveDom();
  return col;
}

function updateLiveDom() {
  const rec = S.rec;
  const m = S.meeting;
  const R = liveDomRefs;
  if (!rec || !m || !R || !R.listEl.isConnected) return;

  const refined = m.rolling?.segments || [];
  const speakers = m.speakers || {};
  const liveLines = (m.draft || []).slice(-18);
  const sig = JSON.stringify([S.health?.media?.live, m.liveStatus, refined, speakers, liveLines]);
  if (R.sig !== sig) {
    R.sig = sig;
    const nearBottom = R.listEl.scrollHeight - R.listEl.scrollTop - R.listEl.clientHeight < 60;
    const nodes = [];
    for (const seg of refined) {
      const spkLabel = (seg.speaker && speakers[seg.speaker]?.label) || '发言人';
      nodes.push(h('div', { class: 'ed-seg-row', 'data-ed-seg': String(seg.i) },
        h('div', { class: 'ed-seg-meta' },
          h('span', { class: 'ed-ts-pill' }, fmt(seg.fromMs)),
          seg.speaker ? h('button', {
            class: 'ed-speaker-btn',
            type: 'button',
            onclick: () => promptRenameSpeaker(seg.speaker, spkLabel),
          }, spkLabel) : null),
        h('p', { class: 'ed-seg-text' }, ...renderSegmentTextNodes(seg))));
    }
    if (liveLines.length) {
      nodes.push(h('div', { class: 'ed-live-tail' },
        h('div', { class: 'ed-live-tail-head' }, '正在实时听写…'),
        ...liveLines.slice(-6).map((l) => h('p', null, l.text))));
    } else if (!refined.length) {
      nodes.push(h('div', { class: 'ed-empty-state' },
        !S.health?.media?.live
          ? '原音正在本机安全录制保存。当前实时字幕通道未开启，每满 1 分钟或结束录音后会自动转写。'
          : '麦克风拾音正常，请开始发言，实时原话将立即显示在这里…'));
    }
    R.listEl.replaceChildren(...nodes);
    if (nearBottom) R.listEl.scrollTop = R.listEl.scrollHeight;
  }

  // Right advisor stream live refresh if recording
  const advStream = $('edLiveAdvisorStream');
  if (advStream) {
    const advSig = JSON.stringify([m.chapters, m.advisorMessages, m.rollingRunning, S.chatPending]);
    if (advStream.dataset.sig !== advSig) {
      advStream.dataset.sig = advSig;
      advStream.replaceChildren(...buildAdvisorStreamNodes(m, true));
      advStream.scrollTop = advStream.scrollHeight;
    }
  }
}

function buildAdvisorStreamNodes(m, isLive) {
  const nodes = [];
  const proactiveMsgs = (m.advisorMessages || []).filter((x) => x.kind === 'proactive');
  const chapters = m.chapters || [];
  const chatMsgs = (m.advisorMessages || []).filter((x) => x.kind === 'chat' || x.kind === 'reply');

  // Top proactive alerts first so executives never miss critical reminders
  for (const pm of proactiveMsgs) {
    nodes.push(h('article', { class: 'ed-proactive-card' },
      h('div', { class: 'ed-proactive-head' },
        h('span', { class: 'ed-proactive-badge' }, pm.badge || '参谋提醒'),
        pm.citations?.[0] ? h('button', {
          class: 'ed-cite-btn',
          type: 'button',
          onclick: () => seekAndPlay(pm.citations[0].ms, pm.citations[0].segIdx),
        }, `原话 ${pm.citations[0].label}`) : null),
      h('h4', null, pm.title),
      h('p', null, pm.text)));
  }

  // Stage effective info cards
  for (const ch of chapters) {
    nodes.push(h('article', { class: 'ed-stage-card' },
      h('div', { class: 'ed-stage-head' },
        h('h4', null, ch.title),
        h('span', { class: 'ed-stage-time' }, `${fmt(ch.startMs)} - ${fmt(ch.endMs)}`)),
      ch.bullets?.length ? h('ul', { class: 'ed-stage-list' }, ch.bullets.map((b) => h('li', null, b))) : null,
      (ch.decisions?.length || ch.actions?.length || ch.openQuestions?.length) ? h('div', { class: 'ed-stage-tags' },
        ...(ch.decisions || []).map((d) => h('div', { class: 'ed-stage-item' },
          h('span', { class: 'ed-mini-tag decision' }, '定论'),
          h('span', null, d.text),
          !isLive ? h('button', { class: 'ed-cite-btn', type: 'button', onclick: () => seekAndPlay(d.startMs, d.segIdx) }, fmt(d.startMs)) : null)),
        ...(ch.actions || []).map((a) => h('div', { class: 'ed-stage-item' },
          h('span', { class: 'ed-mini-tag action' }, '待办'),
          h('span', null, [a.text, a.owner && `责任人：${a.owner}`, a.due && `期限：${a.due}`].filter(Boolean).join(' · ')),
          !isLive ? h('button', { class: 'ed-cite-btn', type: 'button', onclick: () => seekAndPlay(a.startMs, a.segIdx) }, fmt(a.startMs)) : null)),
        ...(ch.openQuestions || []).map((q) => h('div', { class: 'ed-stage-item' },
          h('span', { class: 'ed-mini-tag open' }, '未决'),
          h('span', null, q.reason ? `${q.text}（${q.reason}）` : q.text)))) : null));
  }

  // Q&A messages
  for (const msg of chatMsgs) {
    nodes.push(h('div', { class: `ed-chat-msg ${msg.role === 'user' ? 'user' : 'advisor'}` },
      h('div', null, msg.text),
      msg.citations?.length ? h('div', { class: 'ed-citation-row' },
        msg.citations.map((c) => h('button', {
          class: 'ed-cite-btn',
          type: 'button',
          onclick: () => seekAndPlay(c.ms, c.segIdx),
        }, `听原话 ${c.label}`))) : null));
  }

  if (m.rollingRunning || S.chatPending) {
    nodes.push(h('div', { class: 'ed-chat-msg advisor' }, S.chatPending ? '参谋正在思考并核对实录…' : '参谋正在提炼最新一分钟阶段有效信息…'));
  }

  if (!nodes.length) {
    nodes.push(h('div', { class: 'ed-briefing-card' },
      h('h3', null, isLive ? '随身参谋正在静默旁听' : '本场暂无会中参谋提醒记录'),
      h('p', null, isLive
        ? '每录制满约 1 分钟（或点击右上角「立即提炼阶段小结」），参谋会自动为您过滤寒暄、生成阶段有效信息卡片，并在发现未决风险或历史记忆出入时主动提醒。您也可以随时在下方提问。'
        : '您仍可在下方输入框随时向参谋追问本场录音中的任何原话细节。')));
  }
  return nodes;
}

function renderRightLive(m) {
  const sc = SCENARIO_COPY[m.scenario] || SCENARIO_COPY.meeting;
  const chatInput = h('input', {
    class: 'ed-chat-input',
    type: 'text',
    disabled: S.chatPending,
    placeholder: '会中随时问参谋（如：刚才报的底价是多少？或：待会报告重点列待办）…',
  });
  const streamEl = h('div', { class: 'ed-advisor-stream', id: 'edLiveAdvisorStream' }, ...buildAdvisorStreamNodes(m, true));

  return h('section', { class: 'ed-col', 'aria-label': '会中随身参谋' },
    h('div', { class: 'ed-col-header' },
      h('h2', null, svgIcon('spark', 18), 'AI 随身参谋 · 实时反馈'),
      h('button', {
        class: 'ed-btn',
        type: 'button',
        disabled: Boolean(m.rollingRunning || !m.chunks?.length),
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            if (!(await approveCloudSummary(m))) { renderApp(); return; }
            S.meeting = await api(`/api/meetings/${m.id}/advisor-stage`, { json: {} });
            renderApp();
          } catch (err) { toast(err.message); renderApp(); }
        },
      }, m.rollingRunning ? '正在提炼…' : '立即提炼阶段小结')),
    streamEl,
    h('div', { class: 'ed-copilot-bar' },
      h('div', { class: 'ed-quick-prompts' },
        sc.livePrompts.map((p) => h('button', {
          class: 'ed-quick-pill',
          type: 'button',
          disabled: S.chatPending,
          onclick: () => sendAdvisorMessage(p),
        }, p))),
      h('form', {
        class: 'ed-chat-form',
        onsubmit: (e) => {
          e.preventDefault();
          const v = chatInput.value;
          chatInput.value = '';
          void sendAdvisorMessage(v);
        },
      }, chatInput, h('button', { class: 'ed-chat-send', type: 'submit', disabled: S.chatPending }, S.chatPending ? '请稍候…' : '发送'))));
}

function renderLeftFinished(m) {
  const player = ensureAudioPlayer(m);
  const segs = m.transcript?.segments?.length ? m.transcript.segments : (m.rolling?.segments || []);
  const speakers = m.speakers || {};
  const query = S.transcriptQuery.trim().toLowerCase();
  const rates = [1, 1.25, 1.5, 2];

  const rows = segs.map((seg) => {
    const spkLabel = (seg.speaker && speakers[seg.speaker]?.label) || '发言人';
    const hidden = Boolean(query && !`${spkLabel} ${seg.text}`.toLowerCase().includes(query));
    return h('div', {
      class: 'ed-seg-row',
      hidden,
      'data-ed-seg': String(seg.i),
      'data-from': String(seg.fromMs || 0),
      'data-to': String(seg.toMs || 0),
    },
    h('div', { class: 'ed-seg-meta' },
      h('button', {
        class: 'ed-ts-pill',
        type: 'button',
        title: '点击回听此段原音',
        onclick: () => seekAndPlay(seg.fromMs, seg.i),
      }, fmt(seg.fromMs)),
      seg.speaker ? h('button', {
        class: 'ed-speaker-btn',
        type: 'button',
        title: '点击修改发言人称呼',
        onclick: () => promptRenameSpeaker(seg.speaker, spkLabel),
      }, spkLabel) : null),
    h('p', { class: 'ed-seg-text' }, ...renderSegmentTextNodes(seg)));
  });

  return h('section', { class: 'ed-col', 'aria-label': '原音回听与完整原话' },
    player ? h('div', { class: 'ed-player-deck' },
      h('div', { class: 'ed-player-controls' },
        h('button', {
          id: 'edPlayBtn',
          class: 'ed-play-btn',
          type: 'button',
          'aria-label': player.playing ? '暂停播放' : '播放原音',
          onclick: () => {
            if (player.el.paused) player.el.play().catch(() => {});
            else player.el.pause();
          },
        }, svgIcon(player.playing ? 'pause' : 'play', 18)),
        h('input', {
          id: 'edScrubber',
          class: 'ed-scrubber',
          type: 'range',
          min: '0',
          max: String(Math.max(player.durationMs || 1, player.currentMs)),
          value: String(player.currentMs),
          'aria-label': '录音播放进度',
          oninput: (e) => {
            const ms = Number(e.target.value);
            player.el.currentTime = ms / 1000;
          },
        }),
        h('span', { id: 'edPlayerTime', class: 'ed-player-time' }, `${fmt(player.currentMs)} / ${fmt(player.durationMs || m.durationMs)}`),
        h('button', {
          class: 'ed-speed-btn',
          type: 'button',
          title: '切换倍速',
          onclick: (e) => {
            const nextRate = rates[(rates.indexOf(player.rate) + 1) % rates.length];
            player.rate = nextRate;
            player.el.playbackRate = nextRate;
            e.currentTarget.textContent = `${nextRate}x`;
          },
        }, `${player.rate}x`)))
      : h('div', { class: 'ed-col-header' }, h('h2', null, '正在合成完整原音…')),
    h('div', { class: 'ed-transcript-bar' },
      h('span', null, segs.length ? `完整原话实录（共 ${segs.length} 段 · 点时间回听，点人名改称呼）` : '原话转写记录'),
      segs.length ? h('input', {
        class: 'ed-search-input',
        type: 'search',
        placeholder: '搜索原话关键词…',
        value: S.transcriptQuery,
        oninput: (e) => {
          S.transcriptQuery = e.target.value;
          const q = S.transcriptQuery.trim().toLowerCase();
          document.querySelectorAll('[data-ed-seg]').forEach((el) => {
            el.hidden = Boolean(q && !el.textContent.toLowerCase().includes(q));
          });
        },
      }) : null),
    h('div', { class: 'ed-transcript-list' },
      rows.length ? rows : h('div', { class: 'ed-empty-state' },
        ['pending', 'running'].includes(m.transcript?.status)
          ? '盒端正在完成最终原话校对…'
          : m.transcript?.status === 'offline'
            ? '原音已妥善保存，连接记忆盒子后即可转写原话。'
            : '暂无转写文字')));
}

function renderRightFinished(m) {
  const sc = SCENARIO_COPY[m.scenario] || SCENARIO_COPY.meeting;
  const busy = m.pipelineRunning || S.draftBusy || ['pending', 'running'].includes(m.minutes?.status) || ['pending', 'running'].includes(m.transcript?.status);
  const confirmed = m.review?.status === 'confirmed';
  const ver = m.review?.version || 0;
  const savedSpace = Boolean(ver && m.savedTo?.[ver]?.space);
  const sections = m.summarySections || [];
  const currentText = m.minutes?.document?.text ?? sections.map((s) => [s.heading, ...s.blocks.map((b) => b.text)].join('\n\n')).join('\n\n');
  const advisorCount = (m.advisorMessages || []).filter((x) => x.kind === 'proactive').length + (m.chapters || []).length;

  const templates = S.catalog?.templates || [];
  const depths = S.catalog?.depths || [
    { id: 'brief', name: '极简速览' },
    { id: 'standard', name: '标准提炼' },
    { id: 'detailed', name: '完整详录' },
  ];
  const activeTplId = m.minutes?.template?.id || m.minutesTemplate?.id || 'exec-brief';

  const headerActions = [];
  if (!S.editor && currentText && !busy) {
    headerActions.push(h('button', {
      class: 'ed-btn',
      type: 'button',
      onclick: () => {
        S.rightTab = 'report';
        S.editor = { id: m.id, rev: m.minutes.rev, text: currentText };
        renderApp();
      },
    }, svgIcon('edit', 14), '编辑文字'));
  }
  if (!S.editor && !confirmed && currentText && !busy) {
    headerActions.push(h('button', {
      class: 'ed-btn primary',
      type: 'button',
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          const r = await api(`/api/meetings/${m.id}/confirm`, { json: { documentReview: true, rev: m.minutes.rev } });
          S.meeting = r.meeting;
          await loadMeetings();
          renderApp();
          toast('报告已定稿');
        } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
      },
    }, svgIcon('check', 15), '确认定稿'));
  }
  if (!S.editor && confirmed) {
    headerActions.push(
      h('button', {
        class: `ed-btn ${savedSpace ? 'success-badge' : ''}`,
        type: 'button',
        disabled: savedSpace,
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            S.meeting = await api(`/api/meetings/${m.id}/save`, { json: { destination: 'space', version: ver } });
            renderApp();
            toast('原音与报告已归档至盒子空间');
          } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
        },
      }, savedSpace ? '已归档空间' : '归档到空间'),
    );
  }

  // Config strip (Templates + Depths + Version history)
  const canSwitch = m.transcript?.status === 'done' && (m.transcript?.segments?.length || 0) > 0 && !busy && !S.editor;
  const configStrip = S.rightTab === 'report' && (currentText || canSwitch) ? h('div', { class: 'ed-config-strip' },
    h('div', { class: 'ed-chip-row' },
      h('span', { class: 'ed-chip-label' }, '提炼视角'),
      templates.slice(0, 6).map((tpl) => h('button', {
        class: 'ed-chip',
        type: 'button',
        disabled: !canSwitch,
        'aria-pressed': String(activeTplId === tpl.id),
        onclick: () => switchReportVariant({ templateId: tpl.id, depth: m.depth }),
      }, tpl.name)),
      canSwitch ? h('button', {
        class: 'ed-link-btn',
        type: 'button',
        onclick: () => promptSaveAsTemplate(m),
      }, '＋ 存为常用模板') : null),
    h('div', { class: 'ed-chip-row' },
      h('span', { class: 'ed-chip-label' }, '详略程度'),
      depths.map((d) => h('button', {
        class: 'ed-chip',
        type: 'button',
        disabled: !canSwitch,
        'aria-pressed': String((m.depth || 'standard') === d.id),
        onclick: () => switchReportVariant({ templateId: activeTplId, depth: d.id }),
      }, d.name)),
      (m.drafts?.length > 1) ? [
        h('span', { class: 'ed-chip-label' }, '｜ 历史版本'),
        ...m.drafts.slice(-5).map((dr, i) => h('button', {
          class: 'ed-chip version',
          type: 'button',
          disabled: busy,
          'aria-pressed': String(m.activeDraftId === dr.id),
          onclick: () => activateSavedDraft(dr.id),
        }, dr.label || `版本 ${i + 1}`)),
      ] : null)) : null;

  // Report body
  let mainPane;
  if (S.rightTab === 'advisor') {
    mainPane = h('div', { class: 'ed-advisor-stream' }, ...buildAdvisorStreamNodes(m, false));
  } else if (S.editor) {
    const area = h('textarea', {
      class: 'ed-editor-textarea',
      value: S.editor.text,
      oninput: (e) => { S.editor.text = e.target.value; },
    });
    mainPane = h('div', { class: 'ed-report-doc' },
      h('form', {
        class: 'ed-editor-form',
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            S.meeting = await api(`/api/meetings/${m.id}/minutes`, {
              method: 'PUT',
              json: { rev: S.editor.rev, documentText: S.editor.text },
            });
            S.editor = null;
            renderApp();
            toast('已保存修订后的报告');
          } catch (err) { toast(err.message); }
        },
      },
      area,
      h('div', { class: 'ed-dialog-actions' },
        h('button', { class: 'ed-btn', type: 'button', onclick: () => { S.editor = null; renderApp(); } }, '取消'),
        h('button', { class: 'ed-btn primary', type: 'submit' }, '保存修改'))));
  } else if (busy) {
    mainPane = h('div', { class: 'ed-report-doc' },
      h('div', { class: 'ed-briefing-card' },
        h('h3', null, m.audio?.status !== 'saved'
          ? '正在封存完整高保真原音…'
          : ['pending', 'running'].includes(m.transcript?.status)
            ? '正在校对完整原话时间轴…'
            : '随身参谋正在为您提炼高纯度有效信息报告…'),
        h('p', null, '已录制的会中阶段精修片段会自动复用，稍候片刻即可呈现带原音出处标签的内参级报告。')));
  } else {
    const awaitingSummary = m.minutes?.status === 'waiting' && m.transcript?.status === 'done' && !currentText && S.health?.media?.summarize;
    const failedStage = m.audio?.status !== 'saved' ? 'audio'
      : ['offline', 'error', 'partial'].includes(m.transcript?.status) ? 'transcript'
      : ['offline', 'error'].includes(m.minutes?.status) ? 'minutes' : null;

    const renderBlock = (text, block) => h('p', { class: 'ed-doc-block' },
      text,
      Number.isFinite(block?.startMs) ? h('button', {
        class: 'ed-cite-btn',
        type: 'button',
        title: block.quote ? `原话：「${block.quote}」` : '点击回听原话',
        onclick: () => seekAndPlay(block.startMs, block.segs?.[0] ?? null),
      }, `听原话 ${fmt(block.startMs)}`) : null);

    let docNodes = [];
    if (typeof m.minutes?.document?.text === 'string') {
      const headingsSet = new Set(sections.map((s) => s.heading));
      const blockByText = new Map(sections.flatMap((s) => s.blocks.map((b) => [b.text, b])));
      docNodes = currentText.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
        const cleanHeading = line.replace(/^#+\s*/, '');
        if (headingsSet.has(cleanHeading) || line.startsWith('## ')) {
          return h('div', { class: 'ed-doc-section' }, h('h3', null, cleanHeading));
        }
        return renderBlock(line.replace(/^[-*]\s*/, ''), blockByText.get(line));
      });
    } else if (sections.length) {
      docNodes = sections.map((sec) => h('section', { class: 'ed-doc-section' },
        h('h3', null, sec.heading),
        ...sec.blocks.map((b) => renderBlock(b.text, b))));
    }

    mainPane = h('div', { class: 'ed-report-doc' },
      h('div', { class: 'ed-doc-banner' },
        h('div', null,
          h('h1', null, m.title),
          h('div', { class: 'ed-doc-meta' }, `${sc.name} · ${fmtDate(m.createdAt)} · 时长 ${fmt(m.durationMs)}${m.minutes?.template?.name ? ` · ${m.minutes.template.name}` : ''}`)),
        confirmed ? h('span', { class: 'ed-confirmed-stamp' }, `已定稿 · v${ver}`) : null),
      failedStage || awaitingSummary ? h('div', { class: 'ed-notice-banner' },
        h('span', null, failedStage === 'transcript'
          ? (m.transcript?.error || '当前未连接盒端转写，原音已妥善保存。')
          : awaitingSummary ? '转录已完成，可生成报告。' : (m.minutes?.error || '未能生成报告，请重试。')),
        h('button', {
          class: 'ed-btn primary',
          type: 'button',
          disabled: failedStage === 'transcript' && !S.health?.media?.transcribe,
          onclick: async (e) => {
            const button = e.currentTarget;
            button.disabled = true;
            try {
              const stage = failedStage || 'minutes';
              if (stage === 'minutes' && !(await approveCloudSummary(m))) return;
              S.meeting = await api(`/api/meetings/${m.id}/retry`, { json: { stage } });
              renderApp();
            } catch (err) { toast(err.message); }
            finally { button.disabled = false; }
          },
        }, awaitingSummary ? '生成报告' : failedStage === 'transcript' ? '重试转写' : failedStage === 'audio' ? '重新保存原音' : '重试生成')) : null,
      docNodes.length ? docNodes : (!failedStage && !awaitingSummary ? h('div', { class: 'ed-empty-state' }, '暂无报告') : null));
  }

  const chatInput = h('input', {
    class: 'ed-chat-input',
    type: 'text',
    disabled: S.chatPending || busy,
    placeholder: '对报告不满意？直接吩咐参谋怎么改（如：只留定论和报价，或问某人原话），改到满意为止…',
  });

  return h('section', { class: 'ed-col', 'aria-label': '有效信息报告与参谋调优' },
    h('div', { class: 'ed-col-header' },
      h('div', { class: 'ed-tab-switch', role: 'tablist' },
        h('button', {
          class: 'ed-tab-btn',
          type: 'button',
          role: 'tab',
          'aria-selected': String(S.rightTab === 'report'),
          onclick: () => { S.rightTab = 'report'; renderApp(); },
        }, '有效信息报告'),
        h('button', {
          class: 'ed-tab-btn',
          type: 'button',
          role: 'tab',
          'aria-selected': String(S.rightTab === 'advisor'),
          onclick: () => { S.rightTab = 'advisor'; renderApp(); },
        }, advisorCount ? `参谋提醒与问答 (${advisorCount})` : '参谋问答')),
      h('div', { class: 'ed-report-header-actions' }, ...headerActions)),
    configStrip,
    mainPane,
    !S.editor ? h('div', { class: 'ed-copilot-bar' },
      h('div', { class: 'ed-quick-prompts' },
        sc.postPrompts.map((p) => h('button', {
          class: 'ed-quick-pill',
          type: 'button',
          disabled: S.chatPending || busy,
          onclick: () => sendAdvisorMessage(p),
        }, p))),
      h('form', {
        class: 'ed-chat-form',
        onsubmit: (e) => {
          e.preventDefault();
          const v = chatInput.value;
          chatInput.value = '';
          void sendAdvisorMessage(v);
        },
      }, chatInput, h('button', {
        class: 'ed-chat-send',
        type: 'submit',
        disabled: S.chatPending || busy,
      }, S.chatPending ? '调优中…' : '交办参谋'))) : null);
}

function projectBadgeText(p) {
  if (p.state === 'recording') return '录音中';
  if (p.audio === 'saved' && p.transcript === 'offline') return '待转写';
  if (['pending', 'running', 'composing'].some((st) => [p.audio, p.transcript, p.minutes].includes(st))) return '提炼中';
  if (p.review === 'confirmed') return '已定稿';
  return '待确认';
}

function renderDrawer() {
  let backdrop = $('edDrawerBackdrop');
  if (!backdrop) {
    backdrop = h('div', {
      id: 'edDrawerBackdrop',
      class: 'ed-drawer-backdrop',
      hidden: true,
      onclick: (e) => { if (e.target === backdrop) { S.historyOpen = false; renderDrawer(); } },
    });
    document.body.append(backdrop);
  }
  backdrop.hidden = !S.historyOpen;
  if (!S.historyOpen) return;

  const q = S.historyQuery.trim().toLowerCase();
  const filtered = S.meetings.filter((m) => !q || m.title.toLowerCase().includes(q));

  backdrop.replaceChildren(
    h('aside', { class: 'ed-drawer', 'aria-label': '历史录音记录' },
      h('div', { class: 'ed-drawer-head' },
        h('h2', null, '历史录音记录'),
        h('button', { class: 'ed-btn', type: 'button', onclick: () => { S.historyOpen = false; renderDrawer(); } }, svgIcon('close', 16), '关闭')),
      h('div', { class: 'ed-drawer-search' },
        h('input', {
          type: 'search',
          placeholder: '搜索会议或交谈标题…',
          value: S.historyQuery,
          oninput: (e) => { S.historyQuery = e.target.value; renderDrawer(); },
        })),
      h('div', { class: 'ed-drawer-list' },
        filtered.length ? filtered.map((item) => {
          const scName = SCENARIO_COPY[item.scenario]?.name || '高管会议';
          return h('button', {
            class: `ed-history-item ${S.currentId === item.id ? 'active' : ''}`,
            type: 'button',
            onclick: () => selectMeeting(item.id),
          },
          h('strong', null, item.title),
          h('div', { class: 'ed-history-meta' },
            h('span', null, `${scName} · ${fmtDate(item.createdAt)} · ${fmt(item.durationMs)}`),
            h('span', null, projectBadgeText(item))));
        }) : h('div', { class: 'ed-empty-state' }, S.meetings.length ? '没有找到匹配的记录' : '还没有历史录音'))),
  );
}

function renderBoxDisconnected() {
  const rec = S.rec;
  const title = S.boxReady ? '录音待保存' : '记忆盒子未连接';
  const detail = rec ? '录音已自动暂停保护，点击下方按钮可将完整原音保存在本机。' : '连接半人马AI-记忆盒子后，即可使用会议录音智能体与随身参谋。';
  return h('main', { class: 'ed-workspace' },
    h('section', { class: 'box-connect-notice accessory-box-connect', 'aria-label': '盒子连接提示' },
      h('span', { class: 'box-connect-icon' }, h('span', { class: 'box-connect-glyph', 'aria-hidden': 'true' })),
      h('div', { class: 'box-connect-copy', role: 'status' },
        h('strong', null, title),
        h('p', null, detail),
        rec?.notice ? h('p', { role: 'alert' }, rec.notice) : null),
      rec
        ? h('button', {
          class: 'box-connect-button',
          type: 'button',
          disabled: rec.state === 'finishing',
          onclick: finishRecording,
        }, rec.state === 'finishing' ? '正在保存…' : '结束录音并保存原音')
        : h('a', { class: 'box-connect-button', href: '/accessories/connect-box' }, '去连接记忆盒子')));
}

function renderApp() {
  const app = $('recordingApp');
  if (!app) return;
  liveDomRefs = null;

  if (!S.boxReady || S.rec?.boxInterrupted) {
    app.replaceChildren(renderTopBar(), renderBoxDisconnected());
    renderDrawer();
    return;
  }

  let leftCol, rightCol;
  if (!S.currentId) {
    leftCol = renderLeftSetup();
    rightCol = renderRightSetup();
  } else if (!S.meeting) {
    leftCol = h('section', { class: 'ed-col' }, h('div', { class: 'ed-empty-state' }, '正在读取录音档案…'));
    rightCol = h('section', { class: 'ed-col' }, h('div', { class: 'ed-empty-state' }, '正在同步随身参谋…'));
  } else if (S.meeting.state === 'recording') {
    leftCol = renderLeftLive(S.meeting);
    rightCol = renderRightLive(S.meeting);
  } else {
    leftCol = renderLeftFinished(S.meeting);
    rightCol = renderRightFinished(S.meeting);
  }

  app.replaceChildren(
    renderTopBar(),
    h('main', { class: 'ed-workspace' }, leftCol, rightCol),
  );
  renderDrawer();
  syncPlayerDom();
}

// —— 实时电平波形绘制循环 ——
function drawWaveLoop() {
  const rec = S.rec;
  const R = liveDomRefs;
  if (rec && R && R.waveEl.isConnected) {
    R.timerEl.textContent = fmt(elapsed(rec));
    const c = R.waveEl;
    const g = c.getContext('2d');
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    const n = 56, bw = W / n;
    const lv = rec.levels.slice(-n);
    for (let i = 0; i < n; i++) {
      const v = lv[i - (n - lv.length)] ?? 0;
      const db = v > 0 ? 20 * Math.log10(v) : -90;
      const k = Math.max(0.06, Math.min(1, (db + 58) / 52));
      const bh = k * (H - 18);
      g.fillStyle = v > 0.002 ? '#a47b4d' : '#dacdbd';
      g.fillRect(i * bw + bw * 0.22, (H - bh) / 2, bw * 0.56, bh);
    }
    const rms = rec.state === 'recording' ? rec.rms : 0;
    const db = rms > 0 ? 20 * Math.log10(rms) : -90;
    const msg = rec.uploadError
      || (rec.state === 'finishing' ? '正在安全封存原音…'
        : rec.state === 'paused' ? '已暂停录音'
        : rec.peak > 0.98 ? '音量偏高，麦克风可稍放远一些'
        : db < -52 ? '拾音待命（声音较轻）'
        : '拾音清晰 · 参谋后台跟进中');
    if (R.statusEl.textContent !== msg) R.statusEl.textContent = msg;
  }
  requestAnimationFrame(drawWaveLoop);
}

export async function bootExecutiveDisk() {
  document.body.classList.add('exec-disk-body');
  document.title = '会议录音智能体';
  const icon = document.querySelector('link[rel="icon"]');
  if (icon) icon.href = '/disk-agent.svg';

  window.addEventListener('beforeunload', (e) => {
    if (S.rec || S.starting) { e.preventDefault(); e.returnValue = ''; }
  });

  window.addEventListener('recording-box-connection', (event) => {
    if (typeof event.detail !== 'boolean' || S.boxReady === event.detail) return;
    S.boxReady = event.detail;
    if (!S.boxReady) {
      stopAudioPlayer();
      for (const dlg of document.querySelectorAll('dialog[open]')) dlg.close();
      if (S.rec) {
        S.rec.boxInterrupted = true;
        pauseCapture(S.rec);
        releaseStream(S.rec);
      }
    } else {
      void loadHealth();
      void loadMeetings();
    }
    renderApp();
  });

  window.addEventListener('recording-open-project', (event) => {
    if (!S.boxReady) return;
    if (S.rec || S.starting) { toast('请先结束当前正在进行的录音'); return; }
    if (PROJECT_ID.test(event.detail)) void selectMeeting(event.detail);
  });

  window.addEventListener('recording-authorization', () => {
    void loadHealth();
  });

  window.addEventListener('popstate', () => {
    const id = location.hash.slice(1);
    void selectMeeting(PROJECT_ID.test(id) ? id : null, { replace: true });
  });

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      await refreshDevices();
      if (S.health?.desktop) await updateUsb();
      if (!S.editor) renderApp();
    });
  }

  try { S.settings = await api('/api/settings'); } catch { S.settings = { preferredInput: null, memoryDefault: true }; }
  if (!S.settings.preferredInput) {
    try {
      const cached = JSON.parse(localStorage.getItem(LS_PREF) || 'null');
      if (cached && (cached.deviceId || cached.label)) S.settings.preferredInput = cached;
    } catch { /* ignore */ }
  }

  await Promise.all([
    checkPermission(),
    loadHealth(),
    loadCatalog(),
    loadMeetings(),
  ]);

  if (S.health?.desktop) {
    await updateUsb();
    setInterval(() => { if (!document.hidden) void updateUsb(); }, 4500);
  }

  const initialHash = location.hash.slice(1);
  if (PROJECT_ID.test(initialHash)) {
    await selectMeeting(initialHash, { replace: true });
  } else {
    renderApp();
  }

  setInterval(loadHealth, 20000);
  setInterval(pollActiveMeeting, 750);
  setInterval(() => {
    if (!document.hidden && !S.currentId && !S.starting) void loadMeetings();
  }, 4000);
  requestAnimationFrame(drawWaveLoop);
}
