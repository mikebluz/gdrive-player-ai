# Spoken layers (Learn, Sir Eel) & the voice server

> Moved out of `CLAUDE.md` on 2026-09-15 so it is loaded on demand instead of on every call.
> **Read this before touching speech, the TTS worker, or the voice server.** Add new entries HERE, under the right subheading, following the
> learnings rules in `CLAUDE.md` (a rule someone will break again; sharpen an existing line rather
> than adding a second). The unabridged history is `docs/claude-md-archive.md`.

### Spoken layers (Learn, Sir Eel) & the voice server

- **One engine, different text sources** — adding another source is a branch, not a layer. Three things
  must stay in step: `_ambSpokenType`/`Key`/`Prefix` (keys are `<type>:<id>`), `_ambSpokenSrcKey` (what
  invalidates a queued reading), and the tick's type dispatch.
- **A spoken line is a WRITTEN TAKE**: rendered once, then played strictly in order. Nothing loads
  during playback; the render-ahead cap applies only WHILE PLAYING. Un-rendered lines play as NOTES so
  a layer always makes sound; `Words as` is absolute and never silently degrades to a worse voice.
- **The voice comes from the SERVER by default** (`layer.voiceFrom`: auto|device|server) — the server
  repo is `github.com/mikebluz/bloops-tts-server` (private), deployed on GoDaddy Node hosting, NOT via
  `deploy.sh`. Verify a server deploy with two curls; no phone in the loop.
- **GoDaddy's front proxy strips `access-control-allow-origin` from every response**, so the voice
  rides a JSONP transport when fetch fails. A failed probe must COOL DOWN, and an async capability that
  arrives after a failure must UNDO that failure's state.
- **iOS does not attempt in-tab inference at all** — the model runs in an empty tab but not inside this
  app's memory budget (PROBE CONTEXT ≠ APP CONTEXT). WebKit (`_AMB_WK`) synthesises in ≤3-word chunks,
  caps render-ahead, and the crash latch is STRIKE-based and always recoverable (`bloopsVoiceRetry`).
- **Every await on the worker and every fetch needs a DEADLINE** — `postMessage` has no timeout, and a
  bare `await fetch()` is how the layer hung on mobile. A silent wait is indistinguishable from a hang:
  report download %, count the seconds, and name the failure (`NotAllowedError`/`NotFound`/`NotReadable`
  are three different problems).
- **Synthesis yields to audio** — the pump paces between lines while the transport runs and backs off
  hard when the audio clock is behind.
