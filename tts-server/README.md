# Bloops TTS server

The same KittenTTS voice the desktop app runs in-browser, moved server-side so
phones fetch finished audio instead of running a model inside an iOS tab
(which crashes — the tab's memory budget is already spent on the app itself).

Pure WASM by construction: `onnxruntime-node` and `sharp` are stubbed out at
install (`apply-stub.cjs`), and inference runs on onnxruntime-web's WASM inside
Node. **No native binaries anywhere**, so any host that runs Node ≥ 18 runs
this — shared hosting included.

## Endpoints
- `GET <base>/ping` → `{ ok: true, voices: [...] }`
- `GET <base>?text=…&voice=expr-voice-2-f` → `audio/wav` (24 kHz mono PCM16)

Paths are mount-agnostic: `/tts` + `/tts/ping` standalone, `/` + `/ping` when a
host (cPanel Passenger) strips the mount prefix.

Rendered lines cache on disk in `cache/` (sha1 of voice|text) and serve with
immutable headers — repeats are free at both ends. First-ever request also
downloads the ~24 MB model from HuggingFace (cached in `~/.cache`), so give it
a couple of minutes and outbound network.

## Run locally
    cd tts-server && npm install && npm start        # port 3199 (or PORT env)
    curl 'http://127.0.0.1:3199/tts?text=hello%20there'

## Deploy on GoDaddy cPanel
1. cPanel → **Setup Node.js App** (a.k.a. Application Manager). If your plan
   doesn't show it, this server can live on ANY Node host instead — see
   "Pointing the app at it" below.
2. Create an app: Node 18+ · Application root: upload this `tts-server/`
   folder (cPanel File Manager or FTP — it is deliberately NOT part of
   deploy.sh's static mirror) · Application URL: `yourdomain.com/tts` ·
   Startup file: `tts.js`.
3. In the app's page, click **Run NPM Install** (this also runs `apply-stub.cjs`
   via postinstall — required), then **Start/Restart**.
4. Verify from any machine:  `curl https://yourdomain.com/tts/ping`
   then       `curl -o test.wav 'https://yourdomain.com/tts?text=hello'`
   If those two work, phones work — no phone needed for verification.

## Pointing the app at it
The app defaults to `location.origin + '/tts'` — with the cPanel URL mapping
above, zero configuration. A different host goes in localStorage:
    localStorage.setItem('bloopsTtsUrl', 'https://other-host.example/tts')
No server reachable → phones play words as notes (the built-in floor) and the
layer status says so.
