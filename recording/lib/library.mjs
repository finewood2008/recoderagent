// 试用星图（独立知识仓）、试用记忆、本机设置。全部位于 MEETING_DATA_DIR 内，与正式数据隔离。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  readJson, writeJson, writeFileAtomic, withLock, cleanText, RE, HttpError, newVaultId,
  newMaterialId, newMemoryId, sha256, fmtMs, insideDir, hex,
} from './util.mjs';
import { BUILTIN_TEMPLATES, DEFAULT_TEMPLATE_ID, DEPTH_OPTIONS, SCENARIO_PROFILES, findTemplate, validateTemplate, TEMPLATE_LIMITS } from './minutes-templates.mjs';
import { summaryEvidence } from './minutes.mjs';

const L = {};
export function initLibrary({ data, star, memory, space }) {
  Object.assign(L, { data, star, memory, space, settings: path.join(data, 'settings.json'), memFile: path.join(memory, 'memory.json') });
}

export const DEFAULT_EXEC_PREFS = {
  defaultScenario: 'meeting',
  defaultDepth: 'standard',
  remindUnresolved: true,
  checkMemory: true,
  autoCorrectTerms: true,
  customTerms: [],
};

function sanitizeCustomTerms(raw) {
  if (!Array.isArray(raw)) throw new HttpError(400, '专有名词词表格式无效');
  const out = [];
  for (const item of raw.slice(0, 60)) {
    if (typeof item === 'string') {
      const right = cleanText(item, 40);
      if (right) out.push({ wrong: '', right });
    } else if (item && typeof item === 'object') {
      const wrong = cleanText(item.wrong, 40);
      const right = cleanText(item.right, 40);
      if (right) out.push({ wrong, right });
    }
  }
  return out;
}

// —— 设置（录音偏好设备等）——
const DEFAULT_SETTINGS = { preferredInput: null, memoryDefault: true, executivePreferences: DEFAULT_EXEC_PREFS };
export const getSettings = async () => {
  const s = await readJson(L.settings, DEFAULT_SETTINGS);
  s.executivePreferences = { ...DEFAULT_EXEC_PREFS, ...(s.executivePreferences || {}) };
  return s;
};
export async function putSettings(body) {
  return withLock('settings', async () => {
    const s = await getSettings();
    if ('preferredInput' in body) {
      const p = body.preferredInput;
      if (p === null) s.preferredInput = null;
      else if (p && typeof p === 'object') {
        const deviceId = cleanText(p.deviceId, 200), label = cleanText(p.label, 120);
        if (!deviceId && !label) throw new HttpError(400, 'preferredInput 需要 deviceId 或 label');
        s.preferredInput = { deviceId, label, savedAt: new Date().toISOString() };
      } else throw new HttpError(400, 'preferredInput 格式错误');
    }
    if ('memoryDefault' in body) {
      if (typeof body.memoryDefault !== 'boolean') throw new HttpError(400, 'memoryDefault 必须是布尔值');
      s.memoryDefault = body.memoryDefault;
    }
    if ('defaultTemplateId' in body) {
      const exact = BUILTIN_TEMPLATES.find((t) => t.id === body.defaultTemplateId) || (s.minutesTemplates || []).find((t) => t.id === body.defaultTemplateId);
      if (!exact) throw new HttpError(400, '纪要模板不存在');
      s.defaultTemplateId = body.defaultTemplateId;
    }
    if ('executivePreferences' in body) {
      const ep = body.executivePreferences;
      if (!ep || typeof ep !== 'object' || Array.isArray(ep)) throw new HttpError(400, '参谋偏好格式无效');
      const next = { ...DEFAULT_EXEC_PREFS, ...(s.executivePreferences || {}) };
      if ('defaultScenario' in ep) {
        if (!Object.hasOwn(SCENARIO_PROFILES, ep.defaultScenario)) throw new HttpError(400, '录音场景无效');
        next.defaultScenario = ep.defaultScenario;
      }
      if ('defaultDepth' in ep) {
        if (!Object.hasOwn(DEPTH_OPTIONS, ep.defaultDepth)) throw new HttpError(400, '报告详略档位无效');
        next.defaultDepth = ep.defaultDepth;
      }
      for (const flag of ['remindUnresolved', 'checkMemory', 'autoCorrectTerms']) {
        if (flag in ep) {
          if (typeof ep[flag] !== 'boolean') throw new HttpError(400, `${flag} 必须是布尔值`);
          next[flag] = ep[flag];
        }
      }
      if ('customTerms' in ep) next.customTerms = sanitizeCustomTerms(ep.customTerms);
      s.executivePreferences = next;
    }
    await writeJson(L.settings, s);
    return s;
  });
}

// Earlier checkboxes could be enabled outside the agent. Only an explicit in-agent
// enrollment issues a grant; a new enrollment cannot replay an older grant's queue.
export async function recordingCapture(kind, action) {
  if (!['disk', 'clip'].includes(kind)) throw new HttpError(403, '请从录音智能体操作');
  return withLock('settings', async () => {
    const settings = await getSettings();
    if (action === 'status') return { enabled: Boolean(settings.recordingCaptureGrants?.[kind]) };
    if (action !== 'add' && action !== 'remove') throw new HttpError(400, '自动采集操作无效');
    settings.recordingCaptureGrants ||= {};
    if (action === 'add') settings.recordingCaptureGrants[kind] ||= randomUUID();
    else delete settings.recordingCaptureGrants[kind];
    await writeJson(L.settings, settings);
    return { enabled: action === 'add' };
  });
}

function templateList(settings) {
  return {
    defaultId: settings.defaultTemplateId || DEFAULT_TEMPLATE_ID,
    limits: TEMPLATE_LIMITS,
    scenarios: Object.values(SCENARIO_PROFILES),
    depths: Object.values(DEPTH_OPTIONS),
    executivePreferences: { ...DEFAULT_EXEC_PREFS, ...(settings.executivePreferences || {}) },
    templates: [...BUILTIN_TEMPLATES, ...(settings.minutesTemplates || [])],
  };
}

export async function listMinutesTemplates() { return templateList(await getSettings()); }

export async function saveMinutesTemplate(body) {
  return withLock('settings', async () => {
    const settings = await getSettings();
    const templates = settings.minutesTemplates ||= [];
    const values = validateTemplate(body);
    if (body.id !== undefined) {
      const i = templates.findIndex((t) => t.id === body.id);
      if (i < 0) throw new HttpError(404, '个人模板不存在，内置模板可另存为个人模板');
      if (templates[i].revision !== body.revision) throw new HttpError(409, '模板已在另一窗口更新，请重新打开后编辑');
      templates[i] = { ...templates[i], ...values, revision: templates[i].revision + 1 };
      await writeJson(L.settings, settings);
      return { ...templateList(settings), savedId: templates[i].id };
    }
    const record = { id: `custom-${hex(6)}`, ...values, revision: 1, builtin: false };
    templates.push(record);
    await writeJson(L.settings, settings);
    return { ...templateList(settings), savedId: record.id };
  });
}

export async function resolveMinutesTemplate(id) {
  const settings = await getSettings();
  const target = id || settings.defaultTemplateId || DEFAULT_TEMPLATE_ID;
  const template = BUILTIN_TEMPLATES.find((t) => t.id === target) || (settings.minutesTemplates || []).find((t) => t.id === target);
  if (!template) throw new HttpError(400, '所选纪要模板不存在');
  return template;
}

// —— 试用星图 ——
const vaultDir = (vid) => {
  if (!RE.vault.test(vid || '')) throw new HttpError(400, '仓 ID 无效');
  return path.join(L.star, vid);
};
async function readVault(vid) {
  try { return await readJson(path.join(vaultDir(vid), 'vault.json')); } catch (e) {
    if (e.code === 'ENOENT') throw new HttpError(404, '试用仓不存在');
    throw e;
  }
}

export async function listVaults() {
  const out = [];
  for (const name of await fs.readdir(L.star).catch(() => [])) {
    if (!RE.vault.test(name)) continue;
    try {
      const v = await readVault(name);
      out.push({ id: v.id, name: v.name, description: v.description, createdAt: v.createdAt, materials: v.materials.length });
    } catch { /* 忽略损坏的仓 */ }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function createVault(body) {
  const name = cleanText(body?.name, 40), description = cleanText(body?.description, 120);
  if (!name) throw new HttpError(400, '请填写仓名称');
  return withLock('vaults', async () => {
    const all = await listVaults();
    if (all.length >= 50) throw new HttpError(409, '试用仓数量已达上限');
    if (all.some((v) => v.name === name)) throw new HttpError(409, '已有同名试用仓');
    const v = { schema: 1, id: newVaultId(), name, description, createdAt: new Date().toISOString(), materials: [] };
    await writeJson(path.join(vaultDir(v.id), 'vault.json'), v);
    return { id: v.id, name, description, createdAt: v.createdAt, materials: 0 };
  });
}

export async function getVault(vid) { return readVault(vid); }

export async function getMaterial(vid, mid) {
  if (!RE.material.test(mid || '')) throw new HttpError(400, '材料 ID 无效');
  const v = await readVault(vid);
  const mat = v.materials.find((x) => x.id === mid);
  if (!mat) throw new HttpError(404, '材料不存在');
  const file = path.join(vaultDir(vid), '材料', `${mid}.md`);
  if (!insideDir(L.star, file)) throw new HttpError(400, '路径无效');
  return { vault: { id: v.id, name: v.name }, material: mat, content: await fs.readFile(file, 'utf8') };
}

/** 将会议最新确认版导入指定试用仓；同一会议同一版本导入同一仓时去重。 */
export async function importMeeting(m, vid) {
  if (m.review.status !== 'confirmed' || !m.review.version) throw new HttpError(409, '纪要尚未核对完成，不能导入');
  const ver = m.review.versions[m.review.versions.length - 1];
  const src = path.join(L.space, m.folder, ver.file);
  if (!insideDir(L.space, src)) throw new HttpError(500, '出处路径异常');
  return withLock(`vault:${vid}`, async () => {
    const v = await readVault(vid);
    const key = `${m.id}@v${ver.version}`;
    const dup = v.materials.find((x) => x.key === key);
    if (dup) return { deduped: true, vault: { id: v.id, name: v.name }, material: dup };
    const body = await fs.readFile(src, 'utf8');
    if (sha256(Buffer.from(body)) !== ver.sha256) throw new HttpError(409, '确认版文件与记录不一致，请重新核对');
    const sourcePath = `试用空间 › 录音记录 › ${m.folder} › ${ver.file}`;
    const mat = {
      id: newMaterialId(), key, meetingId: m.id, title: `${m.title} · ${ver.file.includes('录音总结') ? '录音总结' : '会议纪要'} v${ver.version}`, version: ver.version,
      sourcePath, sourceSha256: ver.sha256, importedAt: new Date().toISOString(), status: '待按仓流程核对',
    };
    const content = [
      `> 试用星图材料 · 仓「${v.name}」`,
      `> 出处：${sourcePath}`,
      `> 会议 ID：${m.id}　版本：v${ver.version}　导入时间：${mat.importedAt}`,
      '> 流程：导入为材料 → 按仓设置抽取 → 核对与发布（试用版仅完成第一步）',
      '',
      body,
    ].join('\n');
    await writeFileAtomic(path.join(vaultDir(vid), '材料', `${mat.id}.md`), content);
    v.materials.push(mat);
    await writeJson(path.join(vaultDir(vid), 'vault.json'), v);
    return { deduped: false, vault: { id: v.id, name: v.name }, material: mat };
  });
}

// —— 试用记忆 ——
export const listMemory = () => readJson(L.memFile, { schema: 1, entries: [] });

/** 用确认版中的明确条目（决定、行动项）替换该会议此前的记忆条目；待确认不写入。 */
export async function writeMeetingMemory(m, version) {
  return withLock('memory', async () => {
    const store = await listMemory();
    const kept = store.entries.filter((e) => e.meetingId !== m.id);
    const now = new Date().toISOString();
    const eligible = m.minutes.document
      ? summaryEvidence(m.minutes.document).filter((x) => x.remember)
      : (m.minutes.items || []).filter((x) => x.kind === 'decision' || x.kind === 'action');
    const fresh = eligible.filter((x) => Number.isFinite(x.startMs) && x.quote)
      .map((x) => ({
        id: newMemoryId(), meetingId: m.id, meetingTitle: m.title, version, kind: x.kind || 'fact',
        text: x.text, owner: x.owner || '', due: x.due || '',
        startMs: x.startMs, ts: x.startMs === null || x.startMs === undefined ? '' : fmtMs(x.startMs),
        quote: x.quote || '', recordedAt: m.createdAt, createdAt: now,
        source: `试用空间 › 录音记录 › ${m.folder} › ${m.review.versions.at(-1).file}`,
      }));
    store.entries = kept.concat(fresh);
    await writeJson(L.memFile, store);
    return fresh.length;
  });
}

export async function removeMeetingMemory(id) {
  if (!RE.meeting.test(id)) throw new HttpError(400, '会议 ID 无效');
  return withLock('memory', async () => {
    const store = await listMemory();
    const before = store.entries.length;
    store.entries = store.entries.filter((e) => e.meetingId !== id);
    await writeJson(L.memFile, store);
    return before - store.entries.length;
  });
}

export async function saveDemoAccessoryMemory(p) {
  return withLock('memory', async () => {
    const store = await listMemory();
    const existing = store.entries.find(entry => entry.requestId === p.requestId);
    if (existing) return {id:existing.id};
    const entry = { id:newMemoryId(), meetingId:p.project, meetingTitle:p.title, version:p.version,
      kind:'fact', text:p.content, recordedAt:p.createdAt, createdAt:new Date().toISOString(),
      source:'配件', sourceAgentId:'accessories', accessoryKind:p.kind, requestId:p.requestId };
    store.entries.push(entry);
    await writeJson(L.memFile, store);
    return {id:entry.id};
  });
}
