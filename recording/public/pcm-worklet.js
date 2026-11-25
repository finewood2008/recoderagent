// 原音分片保留浏览器提供的声道。字幕使用独立的 16 kHz 单声道 PCM。
class Pcm16kProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const po = (options && options.processorOptions) || {};
    this.target = 16000;
    this.step = this.target / sampleRate; // 每个输入样本推进的输出相位
    this.phase = 0;
    this.sum = 0;
    this.n = 0;
    this.channels = po.channels || 1;
    this.chunk = Math.round(sampleRate * 5) * this.channels;
    this.buf = new Int16Array(this.chunk);
    this.len = 0;
    this.frames = po.live ? new Int16Array(1600) : null;
    this.frameLen = 0;
    this.active = true;
    this.lvlEvery = Math.max(1, Math.round(sampleRate * 0.05));
    this.lvlN = 0; this.lvlSum = 0; this.lvlPeak = 0;
    this.port.onmessage = (e) => {
      const t = e.data && e.data.type;
      if (t === 'pause') { this.flush(); this.flushFrame(); this.active = false; this.reset(); }
      else if (t === 'resume') { this.reset(); this.active = true; }
      else if (t === 'flush') { this.flush(); this.flushFrame(); this.port.postMessage({ type: 'flushed', id: e.data.id }); }
    };
  }
  flushFrame() {
    if (!this.frameLen) return;
    const out = this.frames.slice(0, this.frameLen);
    this.frameLen = 0;
    this.port.postMessage({ type: 'frame', pcm: out.buffer }, [out.buffer]);
  }
  reset() { this.phase = 0; this.sum = 0; this.n = 0; }
  push(v) {
    if (!this.frames) return;
    this.frames[this.frameLen++] = this.pcm(v);
    if (this.frameLen === this.frames.length) this.flushFrame();
  }
  pcm(v) {
    const x = Math.min(1, Math.max(-1, v));
    return x < 0 ? x * 32768 : x * 32767;
  }
  flush() {
    if (!this.len) return;
    const out = this.buf.slice(0, this.len);
    this.len = 0;
    this.port.postMessage({ type: 'chunk', pcm: out.buffer }, [out.buffer]);
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    const chs = input.length, len = input[0].length;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < chs; c++) v += input[c][i];
      v /= chs;
      if (this.active) {
        for (let c = 0; c < this.channels; c++) this.buf[this.len++] = this.pcm(input[c]?.[i] ?? 0);
        if (this.len >= this.chunk) this.flush();
        this.lvlSum += v * v;
        const a = v < 0 ? -v : v;
        if (a > this.lvlPeak) this.lvlPeak = a;
        if (this.step >= 1) this.push(v);
        else {
          this.sum += v; this.n++; this.phase += this.step;
          if (this.phase >= 1) { this.phase -= 1; this.push(this.sum / this.n); this.sum = 0; this.n = 0; }
        }
      }
      if (++this.lvlN >= this.lvlEvery) {
        this.port.postMessage({ type: 'level', rms: Math.sqrt(this.lvlSum / this.lvlN), peak: this.lvlPeak, active: this.active });
        this.lvlN = 0; this.lvlSum = 0; this.lvlPeak = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm16k', Pcm16kProcessor);
