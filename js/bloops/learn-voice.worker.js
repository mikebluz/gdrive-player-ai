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
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers';

const MODEL = 'Xenova/mms-tts-eng';   // Meta MMS (VITS): text → audio, no phonemizer

let tts = null;
let loading = null;

// One pipeline for the worker's lifetime. Concurrent requests share a single
// load — the first call pays the ~16 s model download, the rest wait on it
// rather than each starting their own.
function getPipeline() {
  if (tts) return Promise.resolve(tts);
  if (!loading) {
    loading = pipeline('text-to-speech', MODEL)
      .then((p) => { tts = p; loading = null; return p; })
      .catch((e) => { loading = null; throw e; });
  }
  return loading;
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const id = msg.id;
  try {
    const text = String(msg.text || '').trim();
    if (!text) { self.postMessage({ id, error: 'empty text' }); return; }
    const p = await getPipeline();
    const out = await p(text);
    const audio = out && out.audio;
    if (!audio || !audio.length) { self.postMessage({ id, error: 'no audio' }); return; }
    // TRANSFER the samples rather than copy them: a spoken sentence is hundreds of
    // KB, and a structured clone of that on every line is exactly the main-thread
    // cost this worker exists to avoid.
    const buf = (audio instanceof Float32Array) ? audio : new Float32Array(audio);
    self.postMessage({ id, audio: buf, sampling_rate: out.sampling_rate || 16000 }, [buf.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
