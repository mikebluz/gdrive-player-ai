// Learn layer voice — OFF THE MAIN THREAD.
//
// transformers.js runs ONNX inference synchronously wherever it is called. On the
// main thread that blocks JS for tens of seconds per sentence, which starves the
// Bloom scheduler: the tick cannot run, scheduled audio drains, and the app looks
// like playback stopped (measured — the audio clock ran 40 s between samples taken
// 6 s apart). Everything model-shaped therefore lives in here, and the main thread
// only ever receives a finished Float32Array.
//
// A MODULE worker, so transformers.js can be imported directly from the CDN — the
// page itself has no bundler and loads plain scripts, but a worker is free to be
// ESM regardless of how the page is built.
//
// THE VOICE IS KittenTTS (StyleTTS2), NOT the `pipeline('text-to-speech', …)` this
// file used to call. Two things forced the shape below:
//   1. `Xenova/mms-tts-eng` (the old voice) is ~60 MB of weights and CRASHED iOS
//      Safari — over the per-tab memory ceiling, so the tab died rather than
//      throwing. Kitten's quantised model is ~24 MB, and it also synthesises
//      FASTER than real time where MMS ran 2-2.7x slower than real time.
//   2. There is no pipeline for it. `style_text_to_speech_2` is absent from
//      transformers.js's MODEL_FOR_TEXT_TO_WAVEFORM mapping (checked in the 4.x
//      dist: only vits / musicgen / supertonic are there), so `pipeline()` cannot
//      resolve the model at all — the HF model card's snippet is boilerplate and
//      does not run. The model must be driven by hand, exactly as kokoro-js drives
//      the same architecture: input_ids + a style vector + speed → waveform.
// And the consequence MMS was originally chosen to avoid: StyleTTS2 eats PHONEMES,
// so a phonemizer is now a real dependency (`phonemizer`, espeak-ng compiled to
// JS — one 1.3 MB self-contained module, no side files to fetch).
// PINNED, not floating. `@4` follows the latest 4.x, which hands a third party a
// deploy button for this feature — a breaking minor release would take the voice
// down with no change on our side. These two versions are the ones every
// measurement in this file was made against.
import { StyleTextToSpeech2Model, AutoTokenizer, Tensor, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
// THE PHONEMIZER IS THE ECHOGARDEN ESPEAK BUILD, NOT the `phonemizer` package.
// The old package (espeak compiled to one giant JS function via wasm2js) HANGS in
// WebKit — worker or main thread, alone on the page, never returns — and poisons
// the process so ort dies beside it with JSC's opaque "Internal error". That was
// the ENTIRE mobile failure: every iOS browser is WebKit under Apple's mandate,
// Chrome included. This build is the same espeak-ng as real WASM, which WebKit
// handles fine (measured: IPA in 1.1 s, model loads beside it, full synthesis
// completes — the first WebKit synthesis of this whole effort). Output is
// byte-identical to the old package after separator stripping (verified across
// test sentences; one dictionary-version vowel nuance in number expansion).
import * as _ESPEAK_NS from 'https://cdn.jsdelivr.net/npm/@echogarden/espeak-ng-emscripten@0.3.5/+esm';
const _espFactory = _ESPEAK_NS.default || _ESPEAK_NS;
let _espeak = null, _espeakLoading = null;
function espeakGet() {
  if (_espeak) return Promise.resolve(_espeak);
  if (!_espeakLoading) {
    _espeakLoading = (async () => {
      const m = await _espFactory();
      const w = new m.eSpeakNGWorker();
      w.set_voice('en-us');
      _espeak = w; _espeakLoading = null; return w;
    })().catch((e) => { _espeakLoading = null; throw e; });
  }
  return _espeakLoading;
}
// Same duty as the old `phonemize(text, 'en-us')`: text → one IPA string. espeak
// returns phonemes underscore-joined with clause newlines; strip to the exact
// shape the Kitten tokenizer was fed all along.
async function phonemize(text) {
  const w = await espeakGet();
  const r = w.synthesize_ipa(String(text));
  return String((r && r.ipa) || '').replace(/_+/g, '').replace(/\s+/g, ' ').trim();
}

// PHONES GET 1 THREAD, DECIDED UP FRONT — this, not the ladder, is the real cure
// for "no available backend found. ERR: [wasm] RangeError". Threaded WASM needs
// SharedArrayBuffer, which this site never has (no cross-origin isolation), and on
// iOS some ort-web builds THROW a RangeError while probing for it instead of
// falling back. Worse, ort-web LATCHES its init promise: once it rejects, the
// ladder's later rungs inherit the same rejection, so retrying inside the same
// worker cannot fix what the first attempt broke. Deciding before the first
// attempt is the documented fix; the ladder below stays as a backstop for other
// failure shapes. On desktop this is a no-op — without SAB, ort runs
// single-threaded anyway.
try { if (typeof SharedArrayBuffer === 'undefined') env.backends.onnx.wasm.numThreads = 1; } catch (e) {}

const MODEL = 'onnx-community/kitten-tts-nano-0.1-ONNX';
// The repo ships expr-voice-{2,3,4,5}-{f,m}. Each is a bare 1 KB style vector
// (256 float32) — unlike Kokoro's, it does NOT vary with token count, so there is
// no slice-by-length step, and switching voice is a different vector against the
// SAME model: no reload, and the ~24 MB download is paid once for all eight.
const VOICES = ['expr-voice-2-f', 'expr-voice-2-m', 'expr-voice-3-f', 'expr-voice-3-m',
  'expr-voice-4-f', 'expr-voice-4-m', 'expr-voice-5-f', 'expr-voice-5-m'];
const VOICE = VOICES[0];
const SAMPLE_RATE = 24000;      // StyleTTS2/Kitten; the model config carries no sampling_rate field
const STYLE_DIM = 256;

let tts = null;                 // { model, tokenizer, styles: Map(voice → Float32Array) }
let loading = null;

// The repo ships ONLY onnx/model_quantized.onnx, i.e. dtype 'q8'. That also rules
// WebGPU out in practice — its EP does not take int8 matmuls, so asking for it
// just costs a failed session build before the WASM fallback. Measured on WASM:
// ~5 s to load cold, and 4.1 s to speak a 5.2 s sentence (0.79x real time).
async function loadStyle(voice) {
  const r = await fetch('https://huggingface.co/' + MODEL + '/resolve/main/voices/' + voice + '.bin');
  if (!r.ok) throw new Error('voice ' + voice + ' HTTP ' + r.status);
  const style = new Float32Array(await r.arrayBuffer());
  if (style.length !== STYLE_DIM) throw new Error('voice vector is ' + style.length + ' floats, expected ' + STYLE_DIM);
  return style;
}
// BACKEND LADDER, for phones. onnxruntime-web reports an init failure as
// "no available backend found. ERR: [wasm] RangeError…", which on iOS is the WASM
// runtime failing to allocate its heap — not the model being too big to download,
// but the runtime being too greedy to start. The knobs that matter are the thread
// count (a threaded build needs SharedArrayBuffer, absent without cross-origin
// isolation, and asking for it can fail outright) and SIMD. Try the plainest
// configuration LAST rather than first, so a capable device still gets the fast
// path and a constrained one still gets a voice at all.
const _BACKENDS = [
  { label: 'default', apply: () => {} },
  { label: '1 thread', apply: () => { env.backends.onnx.wasm.numThreads = 1; } },
  { label: '1 thread, no simd', apply: () => { env.backends.onnx.wasm.numThreads = 1; env.backends.onnx.wasm.simd = false; } },
];
async function buildKitten() {
  // REPORT THE DOWNLOAD. ~24 MB over a phone connection is a long silence, and a
  // silent wait is indistinguishable from a hang — which is exactly how it was
  // reported. transformers.js calls this per file with loaded/total.
  const seen = Object.create(null);
  const progress_callback = (p) => {
    try {
      if (!p || !p.file || !(p.total > 0)) return;
      seen[p.file] = { loaded: p.loaded || 0, total: p.total };
      let l = 0, t = 0;
      for (const k in seen) { l += seen[k].loaded; t += seen[k].total; }
      if (t > 0) self.postMessage({ dl: Math.max(0, Math.min(100, Math.round((l / t) * 100))) });
    } catch (e) {}
  };
  const [tokenizer, style] = await Promise.all([
    AutoTokenizer.from_pretrained(MODEL, { progress_callback }),
    loadStyle(VOICE),
    espeakGet(),      // warm the phonemizer too — first line pays nothing extra
  ]);
  let model = null, lastErr = null;
  for (const b of _BACKENDS) {
    try {
      try { b.apply(); } catch (e) {}
      // WebKit gets ort's memory arena and pattern planner turned OFF: both trade
      // memory for speed by pre-reserving and reusing large blocks, and memory is
      // exactly what iOS is short of — the tab dies where it would merely be slow.
      // Left ON everywhere else, where they are free performance.
      const _wk = (() => { try { const ua = String(navigator.userAgent || '');
        return /iPhone|iPad|iPod|CriOS|FxiOS/.test(ua) || (/AppleWebKit/.test(ua) && !/Chrome\//.test(ua)); } catch (e) { return false; } })();
      model = await StyleTextToSpeech2Model.from_pretrained(MODEL, Object.assign({ dtype: 'q8', progress_callback },
        _wk ? { session_options: { enableCpuMemArena: false, enableMemPattern: false } } : null));
      self.postMessage({ backend: 'wasm/q8 · ' + b.label });
      break;
    } catch (e) {
      lastErr = e;
      // Say which rung failed and why, in full — the status line truncates, but the
      // console is where a device-specific failure actually gets diagnosed.
      try { self.postMessage({ note: 'backend "' + b.label + '" failed: ' + String((e && e.message) || e) }); } catch (e2) {}
    }
  }
  if (!model) throw new Error(String((lastErr && lastErr.message) || lastErr || 'no backend'));
  return { model, tokenizer, styles: new Map([[VOICE, style]]) };
}
// An eSpeak (mespeak) fallback engine lived here briefly on 2026-08-01 — asm.js,
// guaranteed to start anywhere, PCM through the same contract — and was REMOVED
// the same day: the formant voice was judged unusable by ear. If a guaranteed
// in-graph voice is ever wanted again, that build is the known-working shape;
// meanwhile a device that cannot run THIS voice falls back to playing the text
// as notes (see _ambWordOutEff in 17-ambient.js).
const build = buildKitten;
// Voices are fetched ON DEMAND and kept — 1 KB each, so all eight cost less than a
// rounding error against the model, and a voice change never touches the session.
async function styleFor(p, voice) {
  const v = VOICES.indexOf(voice) >= 0 ? voice : VOICE;
  let s = p.styles.get(v);
  if (!s) { s = await loadStyle(v); p.styles.set(v, s); }
  return s;
}
function getPipeline() {
  if (tts) return Promise.resolve(tts);
  if (!loading) {
    loading = build()
      .then((p) => { tts = p; loading = null; return p; })
      .catch((e) => { loading = null; throw e; });
  }
  return loading;
}

// WEBKIT SYNTHESIZES IN SMALL PIECES. Field-measured on an iPhone (Chrome = WebKit
// under Apple's mandate): a 3-word line synthesizes fine, repeatedly, at ~2.2x
// realtime — an ~8-word line KILLS THE TAB, reproducibly (three runs, telemetry).
// The killer is inference memory scaling with input length under iOS's per-tab
// ceiling. So on WebKit each inference is kept in the proven-safe range: the text
// splits at clause punctuation, then every _CHUNK_WORDS words, each piece is
// synthesized alone and the audio is concatenated with short edge fades. The
// prosody gets choppier — each piece carries its own contour — which is the
// accepted price of running at all; Blink keeps whole-line synthesis untouched.
const _WEBKIT = (() => { try {
  const ua = String((typeof navigator !== 'undefined' && navigator.userAgent) || '');
  return /iPhone|iPad|iPod|CriOS|FxiOS/.test(ua) || (/AppleWebKit/.test(ua) && !/Chrome\//.test(ua));
} catch (e) { return false; } })();
// 3, not 4. On-device the safe/unsafe boundary sat between 3 words (survived,
// repeatedly) and ~8 (killed the tab); 4 was a guess at the margin, and a Learn
// article is far more work than the short lines that guess was tested on.
const _CHUNK_WORDS = 3;
// BREATHE BETWEEN INFERENCES. A Wikipedia article is ~10 lines and each line is
// several chunks, so rendering one runs dozens of WASM inferences back to back —
// sustained pressure with no idle moment for the runtime to release intermediate
// buffers, which is a different (and worse) situation from the one-off synthesis
// that was measured working. A short yield per chunk costs nothing perceptible
// and gives the collector a window.
const _breathe = () => new Promise((r) => setTimeout(r, 40));
function _chunkText(text) {
  try {
    const parts = [];
    for (const c of String(text).split(/(?<=[,;:])\s+/)) {
      const ws = c.trim().split(/\s+/).filter(Boolean);
      for (let i = 0; i < ws.length; i += _CHUNK_WORDS) parts.push(ws.slice(i, i + _CHUNK_WORDS).join(' '));
    }
    return parts.length ? parts : [String(text)];
  } catch (e) { return [String(text)]; }
}
async function synth(p, text, voice) {
  if (!_WEBKIT) return _synthOne(p, text, voice);
  const parts = _chunkText(text);
  if (parts.length <= 1) return _synthOne(p, parts[0] || text, voice);
  const bufs = [];
  for (const t of parts) {
    const b = await _synthOne(p, t, voice);
    if (b && b.length) bufs.push(b);
    await _breathe();
  }
  if (!bufs.length) return null;
  const out = new Float32Array(bufs.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const b of bufs) {
    const F = Math.min(96, b.length >> 2);          // ~4 ms edge fades kill seam clicks
    for (let i = 0; i < F; i++) { b[i] *= i / F; b[b.length - 1 - i] *= i / F; }
    out.set(b, off); off += b.length;
  }
  return out;
}
// text → Float32Array. The tokenizer's vocab is IPA (its post-processor wraps the
// sequence in the `$` boundary token), so raw text tokenises to nothing usable —
// everything must go through espeak first.
async function _synthOne(p, text, voice) {
  const ph = await phonemize(text);
  if (!ph) throw new Error('no phonemes');
  const style = await styleFor(p, voice);
  const { input_ids } = p.tokenizer(ph, { truncation: true });
  const out = await p.model({
    input_ids,
    style: new Tensor('float32', style, [1, STYLE_DIM]),
    speed: new Tensor('float32', [1.0], [1]),
  });
  const wf = out && out.waveform;
  return wf ? wf.data : null;
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const id = msg.id;
  try {
    // WARM-UP: load the model and reply, without synthesising anything. The
    // download is the cold cost, and it has nothing to do with playback — the
    // page kicks this off as soon as a Learn layer exists so the wait is spent
    // while the user is still setting up rather than after they press play.
    if (msg.warm) { await getPipeline(); self.postMessage({ id, warm: true, voices: VOICES, gpu: (typeof navigator !== 'undefined') && !!navigator.gpu }); return; }
    const text = String(msg.text || '').trim();
    if (!text) { self.postMessage({ id, error: 'empty text' }); return; }
    const p = await getPipeline();
    const t0 = (self.performance && performance.now) ? performance.now() : 0;
    const audio = await synth(p, text, msg.voice);
    const outSr = SAMPLE_RATE;
    const ms = t0 ? Math.round(performance.now() - t0) : 0;
    if (!audio || !audio.length) { self.postMessage({ id, error: 'no audio' }); return; }
    // TRANSFER the samples rather than copy them: a spoken sentence is hundreds of
    // KB, and a structured clone of that on every line is exactly the main-thread
    // cost this worker exists to avoid.
    const buf = (audio instanceof Float32Array) ? audio : new Float32Array(audio);
    self.postMessage({ id, audio: buf, sampling_rate: outSr, ms: ms }, [buf.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
