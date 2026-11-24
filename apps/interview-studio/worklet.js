// AudioWorklet：任意采样率输入 → mono 16kHz PCM s16le 帧（100-200ms），base64 后交主线程。
// 协议（spec §9.1）：不要假设设备实际采样率，按比例重采样并验证输出帧率。
class Pcm16kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate; // 全局 sampleRate：worklet 内置
    this.pending = []; // 输入采样缓冲
    this.frameSamples = Math.round(this.targetRate * 0.12); // ~120ms/帧
    this.outputPos = 0;
    this.seq = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    this.pending.push(...ch);
    // 按比例攒够一帧输入
    const needInput = Math.floor(this.frameSamples * this.ratio);
    while (this.pending.length >= needInput) {
      const chunk = this.pending.splice(0, needInput);
      // 线性插值重采样到 16k
      const out = new Float32Array(this.frameSamples);
      for (let i = 0; i < this.frameSamples; i++) {
        const srcIdx = i * this.ratio;
        const i0 = Math.floor(srcIdx);
        const i1 = Math.min(i0 + 1, chunk.length - 1);
        const frac = srcIdx - i0;
        out[i] = chunk[i0] * (1 - frac) + chunk[i1] * frac;
      }
      // Float32 → Int16 LE
      const pcm = new Int16Array(out.length);
      for (let i = 0; i < out.length; i++) {
        const s = Math.max(-1, Math.min(1, out[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.seq += 1;
      // Int16 → base64（分帧传输）
      const bytes = new Uint8Array(pcm.buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      this.port.postMessage({ type: 'pcm', seq: this.seq, sampleRate: this.targetRate, data: btoa(binary) });
    }
    return true;
  }
}

registerProcessor('pcm-16k', Pcm16kProcessor);
