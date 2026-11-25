import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { applyTermCorrections, revertCorrectionOnSegment } from '../recording/lib/advisor.mjs';
import { startRecordingServer } from '../recording/server.mjs';

test('standalone server keeps audio local and requires the window credential', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'meeting-recorder-test-'));
  const { origin, close } = await startRecordingServer(dir, 'fixture-window-key');
  t.after(async () => { close(); await rm(dir, { recursive: true, force: true }); });
  const request = (uri, { headers, ...options } = {}) => fetch(origin + uri, {
    ...options, headers: { 'x-recording-view': 'fixture-window-key', ...headers },
  });
  const json = (uri, data, method = 'POST') => request(uri, {
    method, body: JSON.stringify(data), headers: { 'content-type': 'application/json' },
  });

  assert.equal((await fetch(origin + '/')).status, 403);
  assert.equal((await request('/api/health', { headers: { origin: 'https://example.test' } })).status, 403);
  const page = await request('/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await page.text(), /\/launch\.js/);
  assert.equal((await request('/accessories')).status, 404);

  const created = await (await json('/api/meetings', {
    title: '独立录音验收', memoryEnabled: true, preferences: { checkMemory: true },
  })).json();
  assert.equal(created.source, 'disk');
  assert.equal(created.memoryEnabled, false);
  assert.equal(created.preferences.checkMemory, false);

  const meeting = '/api/meetings/' + created.id;
  const pcm = Buffer.alloc(32000);
  pcm.writeInt16LE(4000, 0);
  assert.equal((await request(meeting + '/chunks?seq=0', {
    method: 'POST', body: pcm, headers: { 'content-type': 'application/octet-stream' },
  })).status, 201);
  assert.equal((await json(meeting + '/finish', { chunkCount: 1, audioOnly: true })).status, 202);
  let result;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    result = await (await request(meeting)).json();
    if (!result.pipelineRunning) break;
    await delay(10);
  }
  assert.equal(result.audio.status, 'saved');
  assert.equal(result.transcript.status, 'offline');
  const audio = await request(meeting + '/audio', { headers: { range: 'bytes=0-3' } });
  assert.equal(audio.status, 206);
  assert.equal(await audio.text(), 'RIFF');
  assert.equal((await json(meeting + '/save', { destination: 'memory' })).status, 400);
});

test('reverting automatic correction preserves occurrences that were correct already', () => {
  const raw = '记忆盒子和记忆合子调用万像接口';
  const [corrected] = applyTermCorrections([{ text: raw }]);
  assert.equal(corrected.text, '记忆盒子和记忆盒子调用万象接口');
  const reverted = revertCorrectionOnSegment(corrected, '记忆合子', '记忆盒子');
  assert.equal(reverted.text, '记忆盒子和记忆合子调用万象接口');
});
