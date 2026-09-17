# Deploy & tooling

> Moved out of `CLAUDE.md` on 2026-09-15 so it is loaded on demand instead of on every call.
> **Read this before running `deploy.sh`, adding a page, touching `?v=` stamps, samples import, or the gates' runners.** Add new entries HERE, under the right subheading, following the
> learnings rules in `CLAUDE.md` (a rule someone will break again; sharpen an existing line rather
> than adding a second). The unabridged history is `docs/claude-md-archive.md`.

### Deploy & tooling

- **A new top-level page must be added to `deploy.sh`'s staging `cp` list** or it deploys as a 404
  forever (bitten twice). Verify against **https://mercywizard.com** — the bare FTP IP serves a GoDaddy
  placeholder and 404s live files.
- **Keep the `?v=DEPLOYVER` stamped-file list SMALL** — every stamped file is rewritten and force-put on
  EVERY deploy. JS that needs a cache-busted URL reads `window.__BLOOPS_ASSET_V` instead. A `new Worker(url)`
  is a cached asset and needs the stamp (and its file in the list) or phones keep the old worker.
- **App JS needs a `?v=` bump to reach phones**, and the mirror compares by SIZE — a stamp-only change
  is the same byte length, hence the explicit force-put block.
- **`max-retries exceeded` from every lftp command with the port test passing is an IP BLOCK.** Read the
  FTP BANNER (`printf 'QUIT\r\n' | nc -w 8 HOST 21 | wc -c` → 0 bytes = reset) and curl http:// to prove
  the host is fine. It is IP-level; tether to another network or wait.
- **Never put a backtick or `$( )` inside `deploy.sh`'s lftp heredoc — not even in a comment.** It is
  unquoted by necessity, so the shell runs command substitution over the whole body. `bash -n` does not
  catch it; render through a fake `lftp() { cat; }` and check stderr is empty.
- **`npm run samples`** imports a folder into the shipped library; ids derive from the source-relative
  path and must stay STABLE (a project stores `sample:<id>`). Re-runs diff by size AND mtime+bytes — a
  file edited in place keeps its byte count. In-place mode (a folder already inside `samples/`) copies
  nothing. `kind` is `tuned` / `loop` / `kit`: the axis is "does it carry its own tempo", so a LOOP is
  rate-matched to the project and never transposed by the note.
- **`UI_WAIT_SCALE=0.6 npm run test:ui`** runs the UI gate in ~2:20 by scaling settle waits ≤350 ms
  (longer waits are AUDIO-clock settles and never scale). Dev at 0.6; FINAL verification at 1.
- **`bloopsCoreStrips` / `bloopsCore` READ when called with no argument** — they used to be pure setters,
  and a "is the core on?" check silently disabled strips for the whole session.
