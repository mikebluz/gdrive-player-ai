# Native shell, iOS, Electron

> Moved out of `CLAUDE.md` on 2026-09-15 so it is loaded on demand instead of on every call.
> **Read this before touching the Capacitor shell, iOS audio/session behaviour, or the Electron build.** Add new entries HERE, under the right subheading, following the
> learnings rules in `CLAUDE.md` (a rule someone will break again; sharpen an existing line rather
> than adding a second). The unabridged history is `docs/claude-md-archive.md`.

### Native shell, iOS, Electron

- **The Capacitor shell reroutes ALL audio through a MediaStream** (`00-native-audio.js`, inert on the
  web). Nothing may connect to `rawContext.destination` — use `window._bloopsSpeakerSink(ctx)`, which
  returns the stream node for the LIVE context and `ctx.destination` for an offline one. A direct
  connect re-classifies the context and it gets `interrupted` at every screen lock.
- **`pagehide` tears the media pipeline down** (mute → pause → strip src → `load()`), because a
  navigated-away page's renderer keeps draining a dead feed. It never fires on a plain background —
  that IS the keep-alive design.
- **A shim is per-page opt-in** — `00-native-drive.js` must be loaded BEFORE `google-drive-api.js` on
  every page that uses Drive. Grep for every page loading the library, not the page the bug was on.
- **A stylesheet that reserves space for a FIXED element is only correct on pages that HAVE it** —
  `bloops.css` gives body `padding-top: calc(40px + env(safe-area-inset-top))` for `.float-header`,
  which player.html does not have. `env()` is always 0 in a desktop browser, so shell-only geometry
  bugs are INVISIBLE here — drive the insets as CSS variables so a gate can stand in for a phone.
- **All testing is Chrome.** The one exception: desktop Safari as a WebKit proxy for an iPhone-only bug.
- **Electron:** the packaged shell serves from `app.getAppPath()` (never a hand-built `Resources/app`
  path — with asar that directory does not exist and a 404 body looks like a successful load).
  `@electron/packager` is pinned to 18.3.6 (19+ need Node ≥ 22.12). macOS does NOT throttle a
  backgrounded window — measured; the anti-throttle flags are insurance, not the mechanism.
