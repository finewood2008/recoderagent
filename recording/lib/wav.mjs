// WAV / PCM16 工具：16 kHz 单声道。
import { SAMPLE_RATE } from './util.mjs';

export function wavHeader(dataBytes, sampleRate = SAMPLE_RATE, channels = 1, bits = 16) {
  const h = Buffer.alloc(44);
  const blockAlign = channels * bits / 8;
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export const pcmToWav = (pcm) => Buffer.concat([wavHeader(pcm.length), pcm]);

/** 返回 0..1 的 RMS 与峰值。 */
export function pcmStats(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return { rms: 0, peak: 0 };
  let sum = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return { rms: Math.sqrt(sum / n), peak };
}
