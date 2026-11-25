// AI 随身参谋引擎：会中滚动精修、专有名词静默纠偏、阶段有效信息提炼、高管主动反馈与会后对话调优。
import { cleanText, fmtMs, hex, sha256 } from './util.mjs';
import { DEPTH_OPTIONS, SCENARIO_PROFILES } from './minutes-templates.mjs';
import { norm } from './minutes.mjs';

export const ROLLING_WINDOW_CHUNKS = 12; // 12 * 5s ≈ 60s 滚动精修窗口

export function normalizeScenario(v, fallback = 'meeting') {
  return typeof v === 'string' && Object.hasOwn(SCENARIO_PROFILES, v) ? v : fallback;
}

export function normalizeDepth(v, fallback = 'standard') {
  return typeof v === 'string' && Object.hasOwn(DEPTH_OPTIONS, v) ? v : fallback;
}

export function normalizeMeetingPreferences(input = {}, defaults = {}) {
  const pick = (k, def) => (typeof input?.[k] === 'boolean' ? input[k] : typeof defaults?.[k] === 'boolean' ? defaults[k] : def);
  return {
    remindUnresolved: pick('remindUnresolved', true),
    checkMemory: pick('checkMemory', true),
    autoCorrectTerms: pick('autoCorrectTerms', true),
  };
}

const BUILTIN_TERM_PAIRS = [
  { wrong: '半人马记忆合子', right: '半人马记忆盒子' },
  { wrong: '记忆合子', right: '记忆盒子' },
  { wrong: '万像接口', right: '万象接口' },
];

export function buildCorrectionPairs(customTerms = [], memoryMatches = []) {
  const pairs = [...BUILTIN_TERM_PAIRS];
  const seen = new Set(pairs.map((p) => `${p.wrong}=>${p.right}`));
  for (const item of Array.isArray(customTerms) ? customTerms : []) {
    if (!item || typeof item !== 'object') continue;
    const wrong = cleanText(item.wrong, 40);
    const right = cleanText(item.right, 40);
    if (wrong && right && wrong !== right) {
      const k = `${wrong}=>${right}`;
      if (!seen.has(k)) { seen.add(k); pairs.push({ wrong, right }); }
    }
  }
  // Extract clear entity titles from memory matches only for prompt hinting (never blind-replace without wrong->right)
  const hintTerms = [];
  for (const item of Array.isArray(customTerms) ? customTerms : []) {
    const right = typeof item === 'string' ? cleanText(item, 40) : cleanText(item?.right, 40);
    if (right && !hintTerms.includes(right)) hintTerms.push(right);
  }
  for (const m of Array.isArray(memoryMatches) ? memoryMatches : []) {
    const title = cleanText(m?.title, 40);
    if (title && title.length >= 2 && title.length <= 18 && !hintTerms.includes(title)) hintTerms.push(title);
  }
  return { pairs, hintTerms: hintTerms.slice(0, 30) };
}

export function applyTermCorrections(segments, customTerms = [], enabled = true) {
  if (!enabled) {
    return segments.map((s) => ({ ...s, rawText: s.rawText || s.text, corrections: s.corrections || [] }));
  }
  const { pairs } = buildCorrectionPairs(customTerms);
  if (!pairs.length) {
    return segments.map((s) => ({ ...s, rawText: s.rawText || s.text, corrections: s.corrections || [] }));
  }
  return segments.map((seg) => {
    const rawText = seg.rawText || seg.text;
    let nextText = seg.text;
    const corrections = Array.isArray(seg.corrections) ? [...seg.corrections] : [];
    for (const { wrong, right } of pairs) {
      if (wrong && nextText.includes(wrong)) {
        nextText = nextText.split(wrong).join(right);
        if (!corrections.some((c) => c.from === wrong && c.to === right)) {
          corrections.push({ from: wrong, to: right });
        }
      }
    }
    return { ...seg, rawText, text: nextText, corrections };
  });
}

export function revertCorrectionOnSegment(seg, fromText, toText) {
  const from = cleanText(fromText, 60);
  const to = cleanText(toText, 60);
  if (!seg || !from || !to) return seg;
  const corrections = Array.isArray(seg.corrections) ? seg.corrections : [];
  const idx = corrections.findIndex((c) => c.from === from && c.to === to);
  if (idx < 0) return seg;
  const remaining = corrections.filter((_, i) => i !== idx);
  const text = remaining.reduce((value, pair) => value.replaceAll(pair.from, pair.to), seg.rawText || seg.text);
  return { ...seg, text, corrections: remaining };
}

export function assignSpeakerTurns(segments, existingSpeakers = {}) {
  const speakers = { ...existingSpeakers };
  let activeSpk = 'spk_1';
  let lastEndMs = 0;
  let knownIds = Object.keys(speakers);
  const ensureSpeaker = (rawId) => {
    const id = /^spk_[a-zA-Z0-9_]{1,20}$/.test(String(rawId || ''))
      ? String(rawId)
      : `spk_${cleanText(rawId, 16).replace(/\W+/g, '_') || '1'}`;
    if (!speakers[id]) {
      const n = Object.keys(speakers).length + 1;
      speakers[id] = { id, label: `发言人 ${n}` };
      knownIds = Object.keys(speakers);
    }
    return id;
  };

  const out = segments.map((seg, idx) => {
    let spk = seg.speaker;
    if (spk) {
      spk = ensureSpeaker(spk);
      activeSpk = spk;
    } else {
      if (idx === 0) {
        spk = ensureSpeaker(activeSpk);
      } else {
        const gapMs = (seg.fromMs || 0) - lastEndMs;
        const turnCue = /^(另外|补充一下|我这边|我来说|张总|王总|李总|刘总|陈总|请问|不对|我同意|关于刚才)/.test(seg.text || '');
        if (gapMs >= 2600 || (gapMs >= 1200 && turnCue)) {
          const pool = knownIds.length >= 2 ? knownIds : ['spk_1', 'spk_2'];
          const curIdx = pool.indexOf(activeSpk);
          activeSpk = ensureSpeaker(pool[(curIdx + 1) % pool.length]);
        }
        spk = ensureSpeaker(activeSpk);
      }
    }
    lastEndMs = seg.toMs || seg.fromMs || lastEndMs;
    return { ...seg, speaker: spk };
  });
  return { segments: out, speakers };
}

const STAGE_SYSTEM_PROMPT = [
  '你是企业高管与老板专属的「随身会议参谋」。请阅读这一阶段的真实录音转写片段，去芜存菁，严格输出一个 JSON 对象（不要输出代码块以外的解释文字）。',
  '绝不编造录音中没有出现的事实、人名或数字；凡引用的条目必须填写输入行方括号内的整数编号 segIdx。',
  'JSON 结构如下：',
  '{',
  '  "title": "本阶段议题短标题（6-16字）",',
  '  "bullets": ["核心有效信息要点1（过滤寒暄与重复）", "要点2"],',
  '  "decisions": [{ "text": "明确拍板的结论或关键判断", "segIdx": 0 }],',
  '  "actions": [{ "text": "明确交代的跟进动作", "owner": "负责人（未提则空字符串）", "due": "期限（未提则空字符串）", "segIdx": 0 }],',
  '  "openQuestions": [{ "text": "悬而未决或有争议的问题", "reason": "未决原因或缺失要素", "segIdx": 0 }],',
  '  "corrections": [{ "segIdx": 0, "from": "原转写中的同音错词", "to": "根据上下文或热词表确认的正确专有名词" }],',
  '  "proactive": null 或 {',
  '    "category": "unresolved | memory | opportunity | takeaway",',
  '    "badge": "议题未决提醒 | 历史记忆核对 | 关键信号捕捉 | 落地启发",',
  '    "title": "给老板的一句话醒目提示标题（18字内）",',
  '    "body": "简明扼要的参谋建议或核对发现（80字内，直接点出关键数字、缺失责任人或关联记忆）",',
  '    "segIdx": 0',
  '  }',
  '}',
  '只有在确实存在值得打断或提醒高管的高价值发现时才输出非 null 的 proactive；若一切清晰平淡，proactive 设为 null。',
].join('\n');

function safeJsonParse(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
}

export async function analyzeStageWindow({
  meetingId, scenario = 'meeting', preferences = {}, windowIndex = 0,
  startMs = 0, endMs = 0, segments = [], speakers = {}, priorChapters = [],
  customTerms = [], memoryMatches = [], service,
}) {
  if (!segments.length || !service) return null;
  const byIdx = new Map(segments.map((s) => [s.i, s]));
  const firstSeg = segments[0];
  const resolveSeg = (idx) => (Number.isSafeInteger(idx) && byIdx.has(idx) ? byIdx.get(idx) : firstSeg);

  const scenarioGuide = scenario === 'training'
    ? '当前场景为【培训讲座】：重点提炼核心方法论框架、标杆案例数据与本公司可借鉴动作；proactive 仅在出现极高价值可落地启发时输出（category="takeaway"，badge="落地启发"）。'
    : scenario === 'chat'
      ? '当前场景为【日常交谈/茶叙】：彻底忽略寒暄闲聊，专门捕捉商业情报、对方真实诉求与口头承诺；proactive 在发现重要商机、人脉线索或关键承诺时输出（category="opportunity"，badge="关键信号捕捉"）。'
      : `当前场景为【高管会议】：重点提取拍板定论、责任分工与期限、报价预算数字。${preferences.remindUnresolved !== false ? '若发现议题反复讨论仍未拍板，或安排了任务却没定负责人/期限，请输出 proactive（category="unresolved"，badge="议题未决提醒"）。' : '请勿输出议题未决提醒。'}`;

  const { hintTerms } = buildCorrectionPairs(customTerms, memoryMatches);
  const memoryBlock = preferences.checkMemory !== false && memoryMatches.length
    ? '\n【关联历史记忆（仅供核对数字、前序决议或客户偏好；若发现与当前发言有出入或重要呼应，可输出 category="memory", badge="历史记忆核对" 的 proactive）】：\n'
      + memoryMatches.slice(0, 4).map((m, i) => `${i + 1}. 《${cleanText(m.title, 60)}》：${cleanText(m.snippet, 220)}`).join('\n')
    : '';
  const termBlock = preferences.autoCorrectTerms !== false && hintTerms.length
    ? `\n【已知专有名词参考】：${hintTerms.join('、')}`
    : '';
  const priorBlock = priorChapters.length
    ? `\n【前序阶段已提炼标题（避免重复）】：${priorChapters.slice(-4).map((c) => c.title).join('；')}`
    : '';

  const lines = segments.map((s) => {
    const spk = s.speaker && speakers[s.speaker]?.label ? `(${speakers[s.speaker].label}) ` : '';
    return `[${s.i}] [${fmtMs(s.fromMs)}] ${spk}${cleanText(s.text, 800)}`;
  }).join('\n');

  const input = [scenarioGuide, priorBlock, termBlock, memoryBlock, '\n【本阶段实录原话】：', lines].filter(Boolean).join('\n').slice(0, 28000);
  const tplId = await service.ensureTemplate('录音智能体 · 随身参谋阶段提炼 v2', STAGE_SYSTEM_PROMPT);
  const reqId = 'adv-win-' + sha256(Buffer.from(`${meetingId}:${windowIndex}:${segments.length}:${input.length}`)).slice(0, 28);
  const res = await service.summarize(input, tplId, reqId, false);
  const parsed = safeJsonParse(res?.text || '');
  if (!parsed || typeof parsed !== 'object') return null;

  // Optional conservative LLM-detected homophone corrections on window segments
  const modelCorrections = [];
  if (preferences.autoCorrectTerms !== false && Array.isArray(parsed.corrections)) {
    for (const c of parsed.corrections.slice(0, 8)) {
      const target = Number.isSafeInteger(c?.segIdx) ? byIdx.get(c.segIdx) : null;
      const from = cleanText(c?.from, 30);
      const to = cleanText(c?.to, 30);
      if (target && from && to && from !== to && from.length <= 16 && target.text.includes(from)) {
        modelCorrections.push({ segIdx: target.i, from, to });
      }
    }
  }

  const bullets = (Array.isArray(parsed.bullets) ? parsed.bullets : [])
    .map((b) => cleanText(b, 240)).filter(Boolean).slice(0, 5);
  const decisions = (Array.isArray(parsed.decisions) ? parsed.decisions : []).slice(0, 5).flatMap((d) => {
    const text = cleanText(d?.text, 240);
    if (!text) return [];
    const seg = resolveSeg(d?.segIdx);
    return [{ text, segIdx: seg.i, startMs: seg.fromMs }];
  });
  const actions = (Array.isArray(parsed.actions) ? parsed.actions : []).slice(0, 5).flatMap((a) => {
    const text = cleanText(a?.text, 240);
    if (!text) return [];
    const seg = resolveSeg(a?.segIdx);
    return [{ text, owner: cleanText(a?.owner, 40), due: cleanText(a?.due, 40), segIdx: seg.i, startMs: seg.fromMs }];
  });
  const openQuestions = (Array.isArray(parsed.openQuestions) ? parsed.openQuestions : []).slice(0, 4).flatMap((q) => {
    const text = cleanText(q?.text, 240);
    if (!text) return [];
    const seg = resolveSeg(q?.segIdx);
    return [{ text, reason: cleanText(q?.reason, 120), segIdx: seg.i, startMs: seg.fromMs }];
  });

  if (!bullets.length && !decisions.length && !actions.length && !openQuestions.length) return null;

  const chapter = {
    id: `ch-${hex(4)}`,
    index: windowIndex,
    title: cleanText(parsed.title, 40) || `阶段要点 ${windowIndex + 1}`,
    startMs: startMs ?? firstSeg.fromMs,
    endMs: endMs || segments[segments.length - 1].toMs,
    bullets,
    decisions,
    actions,
    openQuestions,
    createdAt: new Date().toISOString(),
  };

  let proactive = null;
  if (parsed.proactive && typeof parsed.proactive === 'object') {
    const cat = cleanText(parsed.proactive.category, 24) || 'unresolved';
    const allowedByPrefs = (cat !== 'unresolved' || preferences.remindUnresolved !== false)
      && (cat !== 'memory' || preferences.checkMemory !== false);
    const pTitle = cleanText(parsed.proactive.title, 60);
    const pBody = cleanText(parsed.proactive.body, 320);
    if (allowedByPrefs && pTitle && pBody) {
      const seg = resolveSeg(parsed.proactive.segIdx);
      proactive = {
        id: `msg-${hex(5)}`,
        role: 'advisor',
        kind: 'proactive',
        category: cat,
        badge: cleanText(parsed.proactive.badge, 24) || (cat === 'memory' ? '历史记忆核对' : cat === 'opportunity' ? '关键信号捕捉' : cat === 'takeaway' ? '落地启发' : '议题未决提醒'),
        title: pTitle,
        text: pBody,
        citations: [{ label: fmtMs(seg.fromMs), ms: seg.fromMs, segIdx: seg.i }],
        createdAt: new Date().toISOString(),
      };
    }
  }

  return { chapter, proactive, modelCorrections };
}

const QA_SYSTEM_PROMPT = [
  '你是企业高管与老板的「随身会议参谋」。请严格依据提供的录音原话（及可选的关联历史记忆）简洁、直接地回答老板的问题。',
  '要求：语气干练沉稳，不讲套话；凡涉及原话中的关键定论、数字或观点，在句末附上对应的时间戳如 [01:20]；若录音中尚未提及，如实说明“目前录音中尚未提到这一点”。',
].join('\n');

export function isReportRefinementIntent(message, isFinished) {
  if (!isFinished) return false;
  const text = cleanText(message, 500);
  if (!text) return false;
  const questionOnly = /^(请问|谁说|哪一段|什么时候说|有没有提|原话是什么|为什么|多少|哪天).*[？?]?$/.test(text)
    && !/(改|调整|重写|精简|压缩|扩充|只留|只保留|按.*分|生成|总结|报告|版本|格式|语气|口吻|删除|去掉|突出|补充到报告)/.test(text);
  return !questionOnly;
}

export function isFocusNoteIntent(message) {
  const text = cleanText(message, 500);
  return /(待会报告|最终报告|总结里|生成报告时|重点关注|帮我留意|记一下偏好|报告重点)/.test(text);
}

export async function answerAdvisorQuestion({
  meeting, question, liveLines = [], memoryMatches = [], service,
}) {
  const q = cleanText(question, 600);
  const segs = meeting.transcript?.segments?.length
    ? meeting.transcript.segments
    : (meeting.rolling?.segments || []);
  const speakers = meeting.speakers || {};

  const transcriptLines = [
    ...segs.slice(-120).map((s) => {
      const spk = s.speaker && speakers[s.speaker]?.label ? `(${speakers[s.speaker].label}) ` : '';
      return `[#${s.i} ${fmtMs(s.fromMs)}] ${spk}${cleanText(s.text, 500)}`;
    }),
    ...liveLines.slice(-30).map((l) => `[实时 ${fmtMs(l.fromMs || 0)}] ${cleanText(l.text, 400)}`),
  ];

  if (!transcriptLines.length) {
    return {
      text: '当前还没有录到可检索的语音内容。您可以先开始发言，或直接告诉我本场需要重点留意的议题，我会在提炼报告时优先呈现。',
      citations: [],
    };
  }

  const memoryContext = meeting.preferences?.checkMemory !== false && memoryMatches.length
    ? '\n【关联历史记忆】：\n' + memoryMatches.slice(0, 4).map((m) => `- 《${cleanText(m.title, 60)}》：${cleanText(m.snippet, 220)}`).join('\n')
    : '';

  const promptInput = [
    `【录音主题】：${meeting.title}`,
    memoryContext,
    '【录音实录片段】：',
    transcriptLines.join('\n'),
    `\n【高管提问】：${q}`,
  ].filter(Boolean).join('\n').slice(0, 28000);

  const tplId = await service.ensureTemplate('录音智能体 · 参谋问答 v2', QA_SYSTEM_PROMPT);
  const reqId = 'adv-qa-' + sha256(Buffer.from(`${meeting.id}:${Date.now()}:${q}`)).slice(0, 28);
  const res = await service.summarize(promptInput, tplId, reqId, false);
  const replyText = cleanText(res?.text, 2400, { multiline: true }) || '已核对当前实录，暂未发现更多补充信息。';

  // Extract valid [mm:ss] citations mentioned in replyText and match to closest segment
  const citations = [];
  const seenMs = new Set();
  for (const match of replyText.matchAll(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g)) {
    const ms = match[3] !== undefined
      ? (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000
      : (Number(match[1]) * 60 + Number(match[2])) * 1000;
    const closest = segs.find((s) => Math.abs(s.fromMs - ms) <= 6000) || segs.find((s) => ms >= s.fromMs && ms <= s.toMs);
    const targetMs = closest ? closest.fromMs : ms;
    if (!seenMs.has(targetMs)) {
      seenMs.add(targetMs);
      citations.push({ label: fmtMs(targetMs), ms: targetMs, segIdx: closest?.i ?? null });
    }
  }
  return { text: replyText, citations: citations.slice(0, 6) };
}

export function buildExecutiveReportRules({
  templateRules = '',
  scenario = 'meeting',
  depth = 'standard',
  focusNotes = [],
  customInstruction = '',
  previousDraftText = '',
  memoryMatches = [],
}) {
  const scenarioProfile = SCENARIO_PROFILES[normalizeScenario(scenario)];
  const depthProfile = DEPTH_OPTIONS[normalizeDepth(depth)];
  const parts = [
    `场景定位：${scenarioProfile.name}（${scenarioProfile.subtitle}）。`,
    templateRules,
    depthProfile.rules,
  ];
  if (Array.isArray(focusNotes) && focusNotes.length) {
    parts.push('用户在录制前/会中特别交代的关注重点：\n' + focusNotes.map((n, i) => `${i + 1}. ${cleanText(n, 240)}`).join('\n'));
  }
  if (Array.isArray(memoryMatches) && memoryMatches.length) {
    parts.push('可参考的历史记忆背景（仅用于辅助理解专有名词与前序脉络，切勿把未在本次录音中提及的历史事项写成定论）：\n'
      + memoryMatches.slice(0, 3).map((m) => `- ${cleanText(m.title, 50)}：${cleanText(m.snippet, 160)}`).join('\n'));
  }
  if (previousDraftText && customInstruction) {
    parts.push('上一版报告草稿（请在此基础上严格按用户的最新修改指令重写优化，同时保持原话证据引用准确）：\n' + cleanText(previousDraftText, 3500, { multiline: true }));
  }
  if (customInstruction) {
    parts.push('用户最新明确修改要求（最高优先级）：' + cleanText(customInstruction, 1200, { multiline: true }));
  }
  return parts.filter(Boolean).join('\n\n').slice(0, 6500);
}

export function extractMemoryQueryFromSegments(title, segments = []) {
  const sample = segments.slice(-18).map((s) => s.text).join(' ');
  const combined = `${title || ''} ${sample}`.replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
  return combined.slice(0, 200);
}

export function matchesQuoteWithSpeakers(sources, speakers, quoteNorm) {
  if (!quoteNorm || quoteNorm.length < 2) return false;
  const plain = norm(sources.map((s) => s.text).join(''));
  if (plain.includes(quoteNorm)) return true;
  const withRaw = norm(sources.map((s) => `${s.rawText || ''} ${s.text}`).join(''));
  if (withRaw.includes(quoteNorm)) return true;
  const withSpk = norm(sources.map((s) => `${speakers?.[s.speaker]?.label || ''} ${s.text}`).join(''));
  return withSpk.includes(quoteNorm);
}
