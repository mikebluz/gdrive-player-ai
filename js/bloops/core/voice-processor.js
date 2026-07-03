// Bloops core voice engine — AudioWorklet host for the bloops-dsp WASM core.
// 16 stereo outputs, one per layer slot; the main thread connects each slot
// to that layer's existing WebAudio chain. Notes arrive as scheduled events
// (Bloom dispatches ahead) and start sample-accurately inside the core.
class BloopsVoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.wasm = null;
    this.views = null; // [slot][ch] Float32Array views into wasm memory
    this.pending = []; // events that arrived before wasm was ready
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.wasmBytes) {
        WebAssembly.instantiate(d.wasmBytes, {}).then((r) => {
          this.wasm = r.instance.exports;
          this.wasm.init(sampleRate);
          this.refreshViews();
          for (const ev of this.pending) this.dispatch(ev);
          this.pending = [];
          this.port.postMessage({ ready: true });
        }).catch((err) => this.port.postMessage({ error: String(err) }));
        return;
      }
      if (!this.wasm) { this.pending.push(d); return; }
      this.dispatch(d);
    };
  }
  refreshViews() {
    this.views = [];
    for (let s = 0; s < 16; s++) {
      this.views.push([
        new Float32Array(this.wasm.memory.buffer, this.wasm.out_ptr(s, 0), 128),
        new Float32Array(this.wasm.memory.buffer, this.wasm.out_ptr(s, 1), 128),
      ]);
    }
  }
  dispatch(d) {
    try {
      if (d.cmd === 'note') {
        this.wasm.note(d.slot, d.kind, d.freq, d.vel, d.pan, d.t, d.dur, d.a, d.dcy, d.s, d.r, d.detune, d.p0 || 0);
      } else if (d.cmd === 'cancelFrom') {
        this.wasm.cancel_from(d.slot, d.t);
      } else if (d.cmd === 'stopBefore') {
        this.wasm.stop_before(d.slot, d.t);
      } else if (d.cmd === 'cal') {
        if (this.wasm.set_fm_cal) this.wasm.set_fm_cal(d.k);
      } else if (d.cmd === 'kindcal') {
        if (this.wasm.set_kind_cal) this.wasm.set_kind_cal(d.kind, d.k);
      } else if (d.cmd === 'kindgain') {
        if (this.wasm.set_kind_gain) this.wasm.set_kind_gain(d.kind, d.k);
      } else if (d.cmd === 'bassq') {
        if (this.wasm.set_bass_q) this.wasm.set_bass_q(d.q);
      } else if (d.cmd === 'stopAll') {
        this.wasm.stop_all();
      } else if (d.cmd === 'stats') {
        this.port.postMessage({ stats: { voices: this.wasm.active_voices() } });
      }
    } catch (err) {
      this.port.postMessage({ error: String(err) });
    }
  }
  process(inputs, outputs) {
    if (!this.wasm) return true;
    const frames = outputs[0][0].length;
    if (this.views[0][0].buffer !== this.wasm.memory.buffer) this.refreshViews();
    this.wasm.process(currentTime, frames);
    for (let s = 0; s < outputs.length && s < 16; s++) {
      const o = outputs[s];
      o[0].set(this.views[s][0].subarray(0, frames));
      if (o[1]) o[1].set(this.views[s][1].subarray(0, frames));
    }
    return true;
  }
}
registerProcessor('bloops-voice-processor', BloopsVoiceProcessor);
