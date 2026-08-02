// Bloops TTS service — the same KittenTTS the desktop app runs in-browser, moved
// server-side so phones fetch finished audio instead of running a model inside
// an iOS tab (which the app measured crashing — the tab's memory budget is
// already spent on the app itself).
//
//   GET /tts/ping                 → { ok: true }           (client availability probe)
//   GET /tts?text=…&voice=…       → audio/wav (PCM16 mono 24 kHz)
//
// Rendered lines are cached on disk by sha1(voice|text) — Sir Eel and Learn
// repeat lines constantly, so steady-state cost is near zero. Immutable cache
// headers let the BROWSER cache them too.
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3199', 10);
const CACHE = path.join(__dirname, 'cache');
fs.mkdirSync(CACHE, { recursive: true });

const MODEL = 'onnx-community/kitten-tts-nano-0.1-ONNX';
const VOICES = ['expr-voice-2-f', 'expr-voice-2-m', 'expr-voice-3-f', 'expr-voice-3-m',
  'expr-voice-4-f', 'expr-voice-4-m', 'expr-voice-5-f', 'expr-voice-5-m'];
const SR = 24000, STYLE_DIM = 256, MAX_TEXT = 500;

let pipe = null, loading = null;
async function getPipe() {
  if (pipe) return pipe;
  if (!loading) loading = (async () => {
    // PURE WASM, DELIBERATELY — no native binaries anywhere, so the same code
    // runs on shared hosting, any glibc, any CPU. onnxruntime-node is a STUB
    // (transformers imports it eagerly and a missing prebuilt binding is a hard
    // crash at import — reproduced on this very dev machine); the real runtime
    // is onnxruntime-web handed to transformers through the documented hook
    // globalThis[Symbol.for('onnxruntime')], read BEFORE its own backends.
    const T = await import('@huggingface/transformers');
    try {
      T.env.backends.onnx.wasm.numThreads = 1;   // predictable on tiny shared hosts
      // Node's ESM loader only imports file:// and data: URLs — ort-web's default
      // wasm locator hands it something else and dies with
      // ERR_UNSUPPORTED_ESM_URL_SCHEME. Point it at the local dist explicitly.
      const { pathToFileURL } = await import('url');
      T.env.backends.onnx.wasm.wasmPaths = pathToFileURL(path.join(__dirname, 'node_modules', 'onnxruntime-web', 'dist')).href + '/';
    } catch (e) { console.error('[tts] wasm config:', String(e && e.message).slice(0, 120)); }
    const { phonemize } = await import('phonemizer');
    const engine = 'wasm';
    // NO device option: with the Symbol.for('onnxruntime') hook, transformers'
    // supported-device list is empty and any explicit name is rejected — omitted,
    // it falls through to the supplied runtime's own defaults (ort-web = wasm).
    const model = await T.StyleTextToSpeech2Model.from_pretrained(MODEL, { dtype: 'q8' });
    const tokenizer = await T.AutoTokenizer.from_pretrained(MODEL);
    const styles = new Map();
    const styleFor = async (v) => {
      const name = VOICES.includes(v) ? v : VOICES[0];
      if (!styles.has(name)) {
        const r = await fetch('https://huggingface.co/' + MODEL + '/resolve/main/voices/' + name + '.bin');
        styles.set(name, new Float32Array(await r.arrayBuffer()));
      }
      return styles.get(name);
    };
    console.log('[tts] model ready (' + engine + ')');
    return { T, model, tokenizer, styleFor, phonemize };
  })().then(p => { pipe = p; loading = null; return p; })
     .catch(e => { loading = null; throw e; });
  return loading;
}

async function synth(text, voice) {
  const p = await getPipe();
  const ph = (await p.phonemize(text, 'en-us')).join(' ').trim();
  if (!ph) throw new Error('no phonemes');
  const style = await p.styleFor(voice);
  const { input_ids } = p.tokenizer(ph, { truncation: true });
  const out = await p.model({
    input_ids,
    style: new p.T.Tensor('float32', style, [1, STYLE_DIM]),
    speed: new p.T.Tensor('float32', [1.0], [1]),
  });
  return out.waveform.data;   // Float32Array
}

function wav(f32) {
  const n = f32.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767))), 44 + i * 2);
  return buf;
}

// One synthesis at a time — a tiny host stays healthy under a burst, and the
// per-line queue matches how the client asks anyway.
let chain = Promise.resolve();
const enqueue = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const u = new URL(req.url, 'http://x');
  // PATH-AGNOSTIC: standalone this serves /tts and /tts/ping, but cPanel's
  // Passenger mounts the app at a URL prefix and STRIPS it, so the same requests
  // arrive as / and /ping. Accept both shapes.
  const isPing = /\/ping$/.test(u.pathname);
  const isTts = !isPing && (u.pathname === '/tts' || u.pathname === '/' || u.pathname === '');
  if (isPing) {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, voices: VOICES }));
    return;
  }
  if (!isTts) { res.writeHead(404, cors); res.end('not found'); return; }
  const text = String(u.searchParams.get('text') || '').trim().slice(0, MAX_TEXT);
  const voice = String(u.searchParams.get('voice') || '');
  if (!text) { res.writeHead(400, cors); res.end('no text'); return; }
  const key = crypto.createHash('sha1').update(voice + '|' + text).digest('hex');
  const file = path.join(CACHE, key + '.wav');
  try {
    if (!fs.existsSync(file)) {
      const t0 = Date.now();
      const audio = await enqueue(() => synth(text, voice));
      fs.writeFileSync(file, wav(audio));
      console.log('[tts] rendered ' + (audio.length / SR).toFixed(1) + 's in ' + (Date.now() - t0) + 'ms — ' + text.slice(0, 40));
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, { ...cors, 'content-type': 'audio/wav', 'content-length': body.length,
      'cache-control': 'public, max-age=31536000, immutable', 'etag': '"' + key + '"' });
    res.end(body);
  } catch (e) {
    console.error('[tts] failed:', String(e && e.message).slice(0, 160));
    res.writeHead(500, cors); res.end('synthesis failed');
  }
}).listen(PORT, () => console.log('[tts] listening on ' + PORT));
