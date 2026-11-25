import { media } from './media.mjs';
import { cleanText } from './util.mjs';

const sessions = new Map();

export function captions(id) {
  const state = sessions.get(id);
  return { lines: state ? [...state.lines.values()] : [], status: state?.status || 'waiting' };
}

export async function sendLiveFrame(id, frame, service = media, { approxMs = null, onFinal = null } = {}) {
  let state = sessions.get(id);
  if (!state) {
    state = {
      lines: new Map(), generation: 0, status: 'connecting', stream: null,
      attemptAt: 0, opening: null, startedAt: Date.now(), lastMs: 0, onFinal: null,
    };
    sessions.set(id, state);
  }
  if (Number.isFinite(approxMs) && approxMs >= 0) state.lastMs = approxMs;
  if (onFinal) state.onFinal = onFinal;

  if (!state.stream && !state.opening && Date.now() >= state.attemptAt) {
    const generation = ++state.generation;
    const close = () => {
      if (generation !== state.generation) return;
      state.stream = null;
      state.attemptAt = Date.now() + 1000;
      state.status = 'reconnecting';
    };
    state.status = 'connecting';
    state.opening = service.openLive((event) => {
      if (generation !== state.generation) return;
      if (event.type === 'error') { state.stream?.end(); close(); return; }
      if (!['partial', 'final'].includes(event.type) || !Number.isInteger(event.segmentId)) return;
      const key = generation + ':' + event.segmentId;
      const line = cleanText(event.text, 1800);
      const prev = state.lines.get(key);
      if (prev?.final && event.type !== 'final') return;
      const nowMs = state.lastMs || Math.max(0, Date.now() - state.startedAt);
      if (line) {
        const entry = {
          key,
          text: line,
          final: event.type === 'final',
          fromMs: prev?.fromMs ?? nowMs,
          toMs: Math.max((prev?.fromMs ?? nowMs) + 800, nowMs),
        };
        state.lines.set(key, entry);
        if (entry.final && typeof state.onFinal === 'function') {
          try { state.onFinal(entry); } catch { /* ignore listener failure */ }
        }
      } else if (!prev?.final) {
        state.lines.delete(key);
      }
      if (state.lines.size > 800) {
        const firstKey = state.lines.keys().next().value;
        state.lines.delete(firstKey);
      }
    }, close).then(stream => {
      if (generation !== state.generation || !sessions.has(id)) { stream.end(); return; }
      state.stream = stream;
      state.status = 'live';
    }).catch(() => {
      if (generation !== state.generation) return;
      state.status = 'offline';
      state.attemptAt = Date.now() + 3500;
    }).finally(() => { state.opening = null; });
  }
  if (state.opening) await state.opening;
  if (state.stream && !state.stream.send(frame)) {
    state.stream.end();
    state.stream = null;
    state.status = 'reconnecting';
  }
  return state.status;
}

export function finishCaptions(id) {
  const state = sessions.get(id);
  if (!state) return [];
  const finalLines = [...state.lines.values()].filter((x) => x.text);
  state.generation++;
  state.stream?.end();
  sessions.delete(id);
  return finalLines;
}
