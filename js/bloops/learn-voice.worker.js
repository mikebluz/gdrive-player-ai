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
import { StyleTextToSpeech2Model, AutoTokenizer, Tensor } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4';
import { phonemize } from 'https://cdn.jsdelivr.net/npm/phonemizer@1';

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
async function build() {
  const [model, tokenizer, style] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(MODEL, { dtype: 'q8' }),
    AutoTokenizer.from_pretrained(MODEL),
    loadStyle(VOICE),
  ]);
  self.postMessage({ backend: 'wasm/q8' });
  return { model, tokenizer, styles: new Map([[VOICE, style]]) };
}
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

// text → Float32Array. The tokenizer's vocab is IPA (its post-processor wraps the
// sequence in the `$` boundary token), so raw text tokenises to nothing usable —
// everything must go through espeak first.
async function synth(p, text, voice) {
  const ph = (await phonemize(text, 'en-us')).join(' ').trim();
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
    const ms = t0 ? Math.round(performance.now() - t0) : 0;
    if (!audio || !audio.length) { self.postMessage({ id, error: 'no audio' }); return; }
    // TRANSFER the samples rather than copy them: a spoken sentence is hundreds of
    // KB, and a structured clone of that on every line is exactly the main-thread
    // cost this worker exists to avoid.
    const buf = (audio instanceof Float32Array) ? audio : new Float32Array(audio);
    self.postMessage({ id, audio: buf, sampling_rate: SAMPLE_RATE, ms: ms }, [buf.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
