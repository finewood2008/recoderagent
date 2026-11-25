import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  initStore, createMeeting, saveChunk, waitForRollingIdle, finishMeeting,
  renameSpeaker, revertSegmentCorrection, chatWithAdvisor, generateDraftVariant,
  activateDraft, confirmMinutes, patchMeeting, retryStage, view, setMediaService, setRollingWindowChunks, spaceDir,
} from '../recording/lib/meetings.mjs';
import { putSettings, recordingCapture, saveMinutesTemplate, listMinutesTemplates } from '../recording/lib/library.mjs';
import { buildExecutiveReportRules } from '../recording/lib/advisor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '../recording/public');

function createMockBoxMedia() {
  const calls = { transcribe: [], summarize: [], templates: new Map() };
  let tplCounter = 0;

  return {
    mode: 'box',
    calls,
    async scope() { return 'box-scope-exec-test'; },
    async status() {
      return {
        mode: 'box', connected: true,
        granted: ['audio.transcribe', 'audio.transcribe.streaming', 'text.summarize'],
        transcribe: true, live: true, summarize: true, summaryLocation: 'box',
      };
    },
    async requireCapability(id) {
      return {
        processingLocation: 'box',
        chunkBytes: 262144,
        maxInputBytes: 64 * 1024 * 1024,
        info: {
          id,
          configured: true,
          maxFrameBytes: 6400,
          maxDurationSeconds: 3600,
          formats: ['wav', 'mp3', 'm4a', 'flac', 'ogg'],
        },
      };
    },
    async ensureTemplate(name, instructions) {
      const id = `tpl_${++tplCounter}`;
      calls.templates.set(id, { name, instructions });
      return id;
    },
    async transcribe(file, requestId) {
      calls.transcribe.push({ file, requestId });
      if (requestId.startsWith('roll-')) {
        return {
          segments: [
            { startMs: 200, endMs: 4200, speaker: 'spk_1', text: '各位，今天把万像云和记忆合子华东渠道底价定在320万。' },
            { startMs: 4500, endMs: 8800, speaker: 'spk_2', text: '售后驻场交付方案还需要再商量，暂时还没定谁牵头负责。' },
          ],
        };
      }
      // Tail transcription on finish
      return {
        segments: [
          { startMs: 100, endMs: 3600, speaker: 'spk_1', text: '那就拍板底价320万，下周三前由李总监提交售后方案。' },
        ],
      };
    },
    async summarize(text, templateId, requestId) {
      const tpl = calls.templates.get(templateId);
      calls.summarize.push({ text, templateId, templateName: tpl?.name, requestId });

      // 1. Rolling stage advisor analysis
      if (requestId.startsWith('adv-win-')) {
        return {
          model: 'qwen-box-advisor',
          text: JSON.stringify({
            title: '华东渠道底价与售后分歧',
            bullets: [
              '提议将万象云与记忆盒子华东渠道底价定为 320 万',
              '售后驻场交付方案尚未确定牵头负责人',
            ],
            decisions: [{ text: '提议华东渠道底价定为 320 万', segIdx: 0 }],
            actions: [],
            openQuestions: [{ text: '售后驻场交付方案缺负责人', reason: '尚未指定牵头人与期限', segIdx: 1 }],
            proactive: {
              category: 'memory',
              badge: '历史记忆核对',
              title: '底价较 Q3 历史约定下调 30 万，且售后缺责任人',
              body: '记忆盒子显示《华东渠道Q3协议》原定底价为 350 万（本次为 320 万）；此外售后驻场事项尚未明确负责人。',
              segIdx: 0,
            },
          }),
        };
      }

      // 2. Advisor live/post Q&A
      if (requestId.startsWith('adv-qa-')) {
        return {
          model: 'qwen-box-advisor',
          text: '华东渠道底价已明确定在 320 万 [00:00]，较历史 Q3 协议下调了 30 万。',
        };
      }

      // 3. Post-meeting mouldable report generation
      const isBrief = (tpl?.instructions || '').includes('极简高管速览') || (tpl?.instructions || '').includes('只保留核心定论与320万');
      return {
        model: 'qwen-box-advisor',
        text: JSON.stringify({
          sections: [
            {
              heading: isBrief ? '极简拍板结论' : '核心拍板定论',
              blocks: [
                {
                  text: isBrief
                    ? '拍板定论：万象云与记忆盒子华东底价定为 320 万。'
                    : '华东渠道合作底价最终拍板定为 320 万，并明确下周三前补齐售后驻场方案。',
                  evidence: [0, 2],
                  quote: '拍板底价320万',
                  remember: true,
                },
              ],
            },
            ...(isBrief ? [] : [{
              heading: '责任分工与期限',
              blocks: [
                {
                  text: '李总监负责在下周三前提交售后驻场交付方案。',
                  evidence: [2],
                  quote: '下周三前由李总监提交售后方案',
                  remember: true,
                },
              ],
            }]),
          ],
        }),
      };
    },
  };
}

test('executive meeting agent end-to-end: rolling refinement, memory cross-check, fast tail finish, multi-draft tuning & memory capture', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'memobox-exec-agent-'));
  const prevProfile = process.env.RECORDING_MODULE_PROFILE;
  const prevSend = process.send;
  const mockMedia = createMockBoxMedia();

  t.after(async () => {
    setMediaService(null);
    setRollingWindowChunks(12);
    if (prevProfile === undefined) delete process.env.RECORDING_MODULE_PROFILE;
    else process.env.RECORDING_MODULE_PROFILE = prevProfile;
    if (prevSend === undefined) delete process.send;
    else process.send = prevSend;
    await rm(dataDir, { recursive: true, force: true });
  });

  process.env.RECORDING_MODULE_PROFILE = 'accessories';
  setMediaService(mockMedia);
  setRollingWindowChunks(2);
  await initStore(dataDir);

  const memoryQueries = [];
  const savedMemories = [];
  process.send = (msg, cb) => {
    cb?.(null);
    if (msg?.type === 'memory-context-request') {
      memoryQueries.push(msg.query);
      queueMicrotask(() => process.emit('message', {
        type: 'memory-context-result',
        id: msg.id,
        matches: [{ id: 'm-q3', title: '华东渠道Q3协议', snippet: '上次约定华东总代底价为350万，账期45天。' }],
      }));
    } else if (msg?.type === 'accessory-memory') {
      savedMemories.push(msg.payload);
      queueMicrotask(() => process.emit('message', {
        type: 'memory-result',
        id: msg.id,
        memoryId: 'mem-exec-001',
      }));
    }
  };

  // 1. Configure executive preferences, custom terms, and automatic memory capture grant
  await putSettings({
    executivePreferences: {
      defaultScenario: 'meeting',
      defaultDepth: 'standard',
      remindUnresolved: true,
      checkMemory: true,
      autoCorrectTerms: true,
      customTerms: [{ wrong: '万像云', right: '万象云' }],
    },
  });
  await recordingCapture('disk', 'add');

  const created = await createMeeting({
    source: 'disk',
    title: '华东渠道定价高管拍板会',
    scenario: 'meeting',
    focusNotes: ['重点核对华东底价与售后责任人'],
  });
  assert.equal(created.scenario, 'meeting');
  assert.deepEqual(created.focusNotes, ['重点核对华东底价与售后责任人']);

  // 2. Save 2 chunks (10 seconds total) -> triggers rolling window refinement + proactive feedback
  const fiveSecPcm = Buffer.alloc(16000 * 2 * 5, 1);
  await saveChunk(created.id, 0, fiveSecPcm);
  await saveChunk(created.id, 1, fiveSecPcm);
  await waitForRollingIdle(created.id);

  let current = view(created.id);
  assert.equal(current.rolling.transcribedChunks, 2);
  assert.equal(current.rolling.segments.length, 2);
  // Silent conservative term correction applied
  assert.match(current.rolling.segments[0].text, /万象云/);
  assert.match(current.rolling.segments[0].text, /记忆盒子/);
  assert.equal(current.rolling.segments[0].corrections.length, 2);

  // Memory cross-check & proactive golden card generated
  assert(memoryQueries.length >= 1, 'queried local MemoBox historical memories');
  assert.equal(current.chapters.length, 1);
  assert.equal(current.chapters[0].title, '华东渠道底价与售后分歧');
  const proactive = current.advisorMessages.find((m) => m.kind === 'proactive');
  assert(proactive, 'emitted proactive executive feedback card');
  assert.equal(proactive.badge, '历史记忆核对');
  assert.match(proactive.text, /350 万/);

  // 3. Revert one silent term correction cleanly
  current = await revertSegmentCorrection(created.id, 0, { from: '万像云', to: '万象云' });
  assert.match(current.rolling.segments[0].text, /万像云/);
  assert.match(current.rolling.segments[0].text, /记忆盒子/);

  // 4. Mid-meeting Q&A with timestamp citation
  current = await chatWithAdvisor(created.id, { message: '刚才说的底价是多少？' });
  const liveReply = current.advisorMessages.at(-1);
  assert.equal(liveReply.role, 'advisor');
  assert.match(liveReply.text, /320 万/);
  assert.equal(liveReply.citations.length, 1);
  assert.equal(liveReply.citations[0].ms, 200);

  // 5. Append 1 tail chunk and Finish -> Fast Finish only transcribes the tail chunk!
  await saveChunk(created.id, 2, fiveSecPcm);
  await finishMeeting(created.id, { chunkCount: 3 });
  for (let i = 0; i < 120 && view(created.id).minutes.status !== 'done'; i++) {
    await new Promise((r) => setTimeout(r, 15));
  }

  current = view(created.id);
  assert.equal(current.audio.status, 'saved');
  assert.equal(current.transcript.status, 'done');
  assert.equal(current.transcript.source, 'rolling+wanx.media');
  assert.equal(current.transcript.segments.length, 3);
  assert.equal(mockMedia.calls.transcribe.length, 2, 'reused rolling window and transcribed only the tail');
  assert.equal(current.minutes.status, 'done');
  assert.equal(current.drafts.length, 1);

  // 6. Rename speaker and verify persisted transcript updates
  current = await renameSpeaker(created.id, 'spk_1', { label: '王董事长' });
  assert.equal(current.speakers.spk_1.label, '王董事长');
  const transcriptTxt = await readFile(path.join(spaceDir(current), '完整转录.txt'), 'utf8');
  assert.match(transcriptTxt, /\[王董事长\]/);

  // 7. Switch report depth & conversational refinement with version history
  const firstDraftId = current.activeDraftId;
  current = await generateDraftVariant(created.id, { depth: 'brief' });
  assert.equal(current.depth, 'brief');
  assert.equal(current.drafts.length, 2);
  assert.notEqual(current.activeDraftId, firstDraftId);

  // Switch back to version 1 without re-running model, then tune via natural language chat
  const sumCallsBeforeSwitch = mockMedia.calls.summarize.length;
  current = await activateDraft(created.id, firstDraftId);
  assert.equal(mockMedia.calls.summarize.length, sumCallsBeforeSwitch);
  assert.equal(current.activeDraftId, firstDraftId);

  current = await chatWithAdvisor(created.id, { message: '只保留核心定论与320万底价，越精炼越好' });
  assert.equal(current.drafts.length, 3);
  assert.match(current.summarySections[0].heading, /极简拍板结论/);

  // 8. Save custom personal template & confirm final report into MemoBox L1 memory
  const savedTpl = await saveMinutesTemplate({
    name: '董事长一页拍板内参',
    rules: '只列拍板定论、核心金额与第一责任人。',
    scenario: 'meeting',
  });
  assert(savedTpl.templates.some((x) => x.name === '董事长一页拍板内参'));

  const confirmed = await confirmMinutes(created.id, { documentReview: true });
  assert.equal(confirmed.meeting.review.status, 'confirmed');
  assert.equal(confirmed.memory.status, 'saved');
  assert.equal(savedMemories.length, 1);
  assert.equal(savedMemories[0].kind, 'disk');
  assert.match(savedMemories[0].content, /320 万/);
});

test('training and informal chat scenarios + strict CSP compliance on executive UI assets', async () => {
  const catalog = await listMinutesTemplates();
  assert.deepEqual(catalog.scenarios.map((s) => s.id), ['meeting', 'training', 'chat']);
  assert.deepEqual(catalog.depths.map((d) => d.id), ['brief', 'standard', 'detailed']);

  const chatRules = buildExecutiveReportRules({
    templateRules: '提取关键商业情报',
    scenario: 'chat',
    depth: 'brief',
    focusNotes: ['关注明年采购预算'],
  });
  assert.match(chatRules, /日常交谈/);
  assert.match(chatRules, /关注明年采购预算/);

  const jsCode = await readFile(path.join(PUBLIC_DIR, 'executive-disk.js'), 'utf8');
  const cssCode = await readFile(path.join(PUBLIC_DIR, 'executive-disk.css'), 'utf8');

  assert(!/\binnerHTML\b|\bouterHTML\b/.test(jsCode), 'executive-disk.js must not use innerHTML/outerHTML');
  assert(!/\.setAttribute\(\s*['"]style['"]/.test(jsCode), 'executive-disk.js must not set inline style attributes');
  assert(!/\.style\b/.test(jsCode), 'executive-disk.js must not mutate inline element.style under strict CSP');
  assert(!/\p{Extended_Pictographic}/u.test(jsCode), 'executive-disk.js must not contain raw emojis');
  assert(cssCode.includes('.ed-workspace') && cssCode.includes('.ed-proactive-card'), 'executive-disk.css defines two-column & proactive card styles');
});

test('cloud summaries wait for approval for this recording, including during live refinement', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'memobox-cloud-summary-'));
  t.after(async () => {
    setMediaService(null);
    setRollingWindowChunks(12);
    await rm(dataDir, { recursive: true, force: true });
  });
  const service = createMockBoxMedia();
  service.usesCloudSummary = async () => true;
  setMediaService(service);
  setRollingWindowChunks(1);
  await initStore(dataDir);
  const meeting = await createMeeting({ memoryEnabled: false, preferences: { checkMemory: false } });
  await saveChunk(meeting.id, 0, Buffer.alloc(16000 * 2 * 5, 1));
  await waitForRollingIdle(meeting.id);
  assert.equal(view(meeting.id).rolling.transcribedChunks, 1);
  assert.equal(service.calls.summarize.length, 0);
  await assert.rejects(chatWithAdvisor(meeting.id, { message: '请提炼当前内容' }), { status: 409 });
  await finishMeeting(meeting.id, { chunkCount: 1 });
  for (let i = 0; i < 100 && view(meeting.id).pipelineRunning; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(view(meeting.id).transcript.status, 'done');
  assert.equal(view(meeting.id).minutes.status, 'waiting');
  assert.equal(service.calls.summarize.length, 0);
  await patchMeeting(meeting.id, { allowCloudSummary: true });
  await retryStage(meeting.id, 'minutes');
  for (let i = 0; i < 100 && view(meeting.id).pipelineRunning; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(view(meeting.id).minutes.status, 'done');
  assert(service.calls.summarize.length > 0);
});
