// Phase-0 spike worklet: N concurrent FM voices computed in a single sample
// loop — either in Rust/WASM (bloops-dsp) or the identical math in plain JS.
// Reports its own busy-time per second so the bench can compute DSP load.
class BenchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = 'js';
    this.n = 0;
    this.wasm = null;
    this.wasmBuf = null;
    // JS engine state (same model as the Rust core)
    this.voices = [];
    this.busyMs = 0;
    this.blocks = 0;
    this.lastReport = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.wasmBytes) {
        WebAssembly.instantiate(d.wasmBytes, {}).then((r) => {
          this.wasm = r.instance.exports;
          this.wasm.init(sampleRate);
          this.wasmBuf = new Float32Array(this.wasm.memory.buffer, this.wasm.buf_ptr(), 128);
          this.port.postMessage({ ready: 'wasm' });
        }).catch((err) => {
          this.port.postMessage({ error: 'instantiate: ' + String(err) });
        });
      }
      if (d.mode) this.mode = d.mode;
      if (typeof d.voices === 'number') this.setVoices(d.voices);
    };
  }
  setVoices(n) {
    this.n = n;
    if (this.wasm) this.wasm.set_voices(n);
    this.voices = [];
    for (let i = 0; i < n; i++) {
      this.voices.push({ pc: 0, pm: 0, freq: 65 * (1 + (i % 24) * 0.12), t: (i * 0.037) % 0.6 });
    }
  }
  env(t) {
    if (t < 0.01) return t / 0.01;
    if (t < 0.11) return 1 - 0.5 * ((t - 0.01) / 0.1);
    if (t < 0.45) return 0.5;
    if (t < 0.6) return 0.5 * (1 - (t - 0.45) / 0.15);
    return 0;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const frames = L.length;
    const t0 = Date.now();
    if (this.mode === 'wasm' && this.wasm) {
      // memory may have grown — refresh the view lazily
      if (this.wasmBuf.buffer !== this.wasm.memory.buffer) {
        this.wasmBuf = new Float32Array(this.wasm.memory.buffer, this.wasm.buf_ptr(), 128);
      }
      this.wasm.process(frames);
      L.set(this.wasmBuf.subarray(0, frames));
      R.set(this.wasmBuf.subarray(0, frames));
    } else {
      const dt = 1 / sampleRate, TAU = Math.PI * 2;
      L.fill(0);
      for (const v of this.voices) {
        const incC = v.freq * dt, incM = v.freq * 3 * dt;
        let pc = v.pc, pm = v.pm, t = v.t;
        for (let f = 0; f < frames; f++) {
          const env = this.env(t);
          const m = Math.sin(pm * TAU);
          L[f] += Math.sin((pc + 10 * m * incC) * TAU) * env;
          pc += incC; if (pc >= 1) pc -= 1;
          pm += incM; if (pm >= 1) pm -= 1;
          t += dt; if (t >= 0.6) t -= 0.6;
        }
        v.pc = pc; v.pm = pm; v.t = t;
      }
      const g = 0.5 / Math.max(1, this.n);
      for (let f = 0; f < frames; f++) L[f] *= g;
      if (R !== L) R.set(L);
    }
    this.busyMs += Date.now() - t0;
    this.blocks++;
    // report roughly once a second (in audio time)
    if (currentTime - this.lastReport >= 1) {
      this.port.postMessage({ busyMs: this.busyMs, blocks: this.blocks, at: currentTime });
      this.busyMs = 0; this.blocks = 0; this.lastReport = currentTime;
    }
    return true;
  }
}
registerProcessor('bench-processor', BenchProcessor);
