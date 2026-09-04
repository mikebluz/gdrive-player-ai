#!/bin/bash
# -----------------------------------------------
# GoDaddy Shared Hosting Static Deployment Script
# -----------------------------------------------
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh
# -----------------------------------------------

set -e

# -----------------------------------------------
# CONFIGURATION — loaded from deploy.env
# -----------------------------------------------
if [[ ! -f "deploy.env" ]]; then
  echo "❌ Error: deploy.env not found. Copy deploy.example.env and fill in your FTP credentials."
  exit 1
fi
source deploy.env
# -----------------------------------------------

# Validate config
if [[ -z "$FTP_HOST" || -z "$FTP_USER" || -z "$FTP_PASS" || -z "$REMOTE_DIR" ]]; then
  echo "❌ Error: Fill in the CONFIGURATION section of deploy.sh before running."
  exit 1
fi

# Ensure credentials file exists (and is filled in) before deploying.
# js/config.js is gitignored, so it only reaches the server through this
# upload — a missing or placeholder file means the deployed app throws
# "Missing Google API config (js/config.js)." at sign-in.
if [[ ! -f "js/config.js" ]]; then
  echo "❌ Error: js/config.js not found. Copy js/config.example.js to js/config.js and fill in your credentials."
  exit 1
fi
if grep -q "YOUR_CLIENT_ID\|YOUR_API_KEY" js/config.js; then
  echo "❌ Error: js/config.js still has placeholder credentials. Fill in your real CLIENT_ID and API_KEY."
  exit 1
fi

# -----------------------------------------------
# Make sure the dev sign-in bypass isn't shipped to production. The
# bloops.html source carries `const DEV_BYPASS_SIGNIN = true|false;`
# and we want it as `false` for the deployed build (sign-in required).
# If it's currently `true`, flip it to `false` for the upload, then
# flip it back at the end so local dev mode survives the deploy.
# -----------------------------------------------
DEV_BYPASS_FLIPPED=0
if grep -qE 'const[[:space:]]+DEV_BYPASS_SIGNIN[[:space:]]*=[[:space:]]*true' bloops.html; then
  echo "⚠️  DEV_BYPASS_SIGNIN was set to true in bloops.html — flipping to false for deploy."
  # macOS / BSD sed needs a backup-suffix arg; keep the in-place edit
  # portable by writing then moving.
  sed -E 's/(const[[:space:]]+DEV_BYPASS_SIGNIN[[:space:]]*=[[:space:]]*)true/\1false/' bloops.html > bloops.html.tmp
  mv bloops.html.tmp bloops.html
  DEV_BYPASS_FLIPPED=1
  echo "    ✅ Auth flow enabled for the uploaded build."
fi

echo "🚀 Starting deployment to $FTP_HOST..."

# -----------------------------------------------
# Stage static files only
# -----------------------------------------------
STAGE_DIR=$(mktemp -d)
# Restore DEV_BYPASS_SIGNIN=true on every exit path (success or failure)
# so the local copy goes back to dev mode regardless of whether lftp
# completed. Stage dir cleanup runs alongside.
restore_dev_bypass() {
  if [[ "$DEV_BYPASS_FLIPPED" == "1" ]]; then
    echo "🔧 Restoring DEV_BYPASS_SIGNIN=true for local dev."
    sed -E 's/(const[[:space:]]+DEV_BYPASS_SIGNIN[[:space:]]*=[[:space:]]*)false/\1true/' bloops.html > bloops.html.tmp
    mv bloops.html.tmp bloops.html
  fi
}
trap 'rm -rf "$STAGE_DIR"; restore_dev_bypass' EXIT

# TIMING. "The deploy is slow" is unactionable without knowing WHICH phase — the
# local copy, the remote diff, or the transfer. Each phase reports its seconds.
_T0=$(date +%s)
_phase() { local now=$(date +%s); echo "   ⏱  $1: $((now - _T0))s"; _T0=$now; }
echo "📦 Staging files..."
# img/ is REQUIRED by index.html — it holds the pixel-art wallpaper, the live
# photo and the handwritten wordmark. Without it the desktop ships as a flat
# green field with three broken images.
cp -r index.html bloops.html player.html artwork.html game.html tracks.html notepad.html chords.html saw.html css js img audio banner.jpg me2026.jpg samples artwork vendor "$STAGE_DIR/"
# Caching policy (HTML revalidates every load; versioned assets cache long) —
# without it, phones cache stale HTML pointing at old ?v= assets and boot dies.
cp .htaccess "$STAGE_DIR/"

# -----------------------------------------------
# Cache-bust: stamp a fresh version onto the staged HTML's asset URLs so
# browsers (and GoDaddy's edge cache) always fetch the just-deployed JS/CSS
# instead of a stale copy. The repo keeps the literal "?v=DEPLOYVER" token;
# only the uploaded copies get the timestamp. Avoids per-file stale-cache
# bugs where one module updates and another is served from cache.
# -----------------------------------------------
DEPLOY_VER=$(date +%Y%m%d%H%M%S)
echo "🏷️  Cache-busting asset URLs with v=$DEPLOY_VER"
# JS files that fetch versioned assets themselves (worklet module + wasm URLs in
# the core-voices bridge) carry the same ?v=DEPLOYVER token as the HTML. KEEP THIS
# LIST SMALL: every file on it is rewritten and then force-uploaded below, every
# deploy, whether or not it changed. js/bloops/17-ambient.js was briefly on it for
# ONE Worker URL and cost 2.2 MB of forced upload per deploy (~12x the rest of the
# forced payload combined) — it now reads the stamp from `window.__BLOOPS_ASSET_V`,
# published by bloops.html, which is 92 KB and already forced.
# notepad.html is deliberately ABSENT from this list: its script is INLINE, so
# there is no external asset URL to cache-bust, and every stamped file is
# rewritten and force-uploaded on EVERY deploy whether it changed or not. It is
# mirrored by size like any other page.
for f in index.html bloops.html player.html artwork.html game.html tracks.html js/bloops/03b-core-voices.js; do
  if [[ -f "$STAGE_DIR/$f" ]]; then
    sed "s/?v=DEPLOYVER/?v=$DEPLOY_VER/g" "$STAGE_DIR/$f" > "$STAGE_DIR/$f.tmp" && mv "$STAGE_DIR/$f.tmp" "$STAGE_DIR/$f"
  fi
done

# -----------------------------------------------
# Upload via SFTP using lftp
# -----------------------------------------------
echo "🔌 Testing connection to $FTP_HOST on port 21..."
# A TCP-CONNECT TEST IS NOT ENOUGH. GoDaddy's brute-force protection blocks an IP
# by accepting the connection and then RESETTING it before the FTP banner, so
# `nc -z` reports success and every later lftp command dies with the useless
# "max-retries exceeded". Read the 220 banner instead — that is the difference
# between "the port is open" and "the FTP service will talk to me".
if ! nc -zw5 "$FTP_HOST" 21 >/dev/null 2>&1; then
  echo "❌ Cannot reach $FTP_HOST on port 21 (FTP). Check the IP and that FTP is enabled."
  exit 1
fi
FTP_BANNER=$(printf 'QUIT\r\n' | nc -w 8 "$FTP_HOST" 21 2>/dev/null | head -1)
if [[ -z "$FTP_BANNER" ]]; then
  echo "❌ Port 21 accepts the connection but the FTP service sent no banner —"
  echo "   the server reset us. That is almost always an IP BLOCK, not a network"
  echo "   fault (repeated FTP logins trip GoDaddy's brute-force protection)."
  echo "   • the site itself is usually fine — check http://$FTP_HOST/ in a browser"
  echo "   • the block is IP-LEVEL, not FTP-specific: ports 990/2222/21098 reset too,"
  echo "     while http:// still answers 200 — so switching ports will not help"
  echo "   • FASTEST WAY OUT: deploy from a different IP — tether to your phone's"
  echo "     hotspot and re-run. A new public IP is not blocked."
  echo "   • otherwise it is normally temporary: wait ~15-60 min and retry"
  echo "   • or clear it now: cPanel → Security → IP Blocker (remove this IP)"
  MY_IP=$(curl -s --max-time 6 https://api.ipify.org 2>/dev/null)
  [[ -n "$MY_IP" ]] && echo "   • this machine's public IP: $MY_IP"
  exit 1
fi
echo "✅ FTP responding: $FTP_BANNER"

_phase "staging + stamping"
# DIAGNOSTIC: DEPLOY_DRYRUN=1 ./deploy.sh — ask the mirror what it WOULD transfer
# and stop. Local staging is ~0.3s for the whole 18 MB, so a slow deploy is always
# the FTP session, and the only question worth asking is whether it is re-sending
# files that have not changed. This answers that in one run, uploading nothing.
if [[ -n "$DEPLOY_DRYRUN" ]]; then
  echo "🔍 Dry run — files the mirror would transfer (nothing is uploaded):"
  lftp -u "$FTP_USER","$FTP_PASS" ftp://"$FTP_HOST" <<EOF
set ftp:ssl-allow no
set net:timeout 40
mirror --reverse --verbose --ignore-time --dry-run "$STAGE_DIR/" "$REMOTE_DIR/"
bye
EOF
  _phase "dry-run diff"
  echo "(plus the 8 always-forced stamped files, ~0.22 MB)"
  exit 0
fi

echo "⬆️  Uploading to $REMOTE_DIR..."

# NO -d. That is lftp DEBUG mode — every protocol exchange echoed to the terminal,
# a wall of output on a healthy deploy, and terminal I/O is not free. Set
# DEPLOY_DEBUG=1 to put it back when a transfer is actually misbehaving.
# NO BACKTICKS OR $( ) BELOW THIS LINE, INCLUDING IN COMMENTS. The heredoc is
# UNQUOTED (it must be — $STAGE_DIR/$REMOTE_DIR have to expand), so the shell runs
# command substitution over the WHOLE body before lftp sees it; `foo` in a comment
# is executed by the shell. That shipped once: "reconnect-interval-base: command
# not found" ×2 and a swallowed mirror line, mid-deploy.
lftp ${DEPLOY_DEBUG:+-d} -u "$FTP_USER","$FTP_PASS" ftp://"$FTP_HOST" <<EOF
set ftp:ssl-allow no
# Robust transfer: retry stalled/failed transfers instead of giving up after
# one attempt (a truncated big file — e.g. the ~1.3 MB js/bloops/17-ambient.js
# — over a slow/flaky FTP link parse-errors and black-screens the app). Longer
# timeout + reconnects + always-overwrite so a partial remote file is replaced.
# THE SLEEPS COME FROM HERE. When the server refuses or drops a connection, lftp
# does not fail — it WAITS net:reconnect-interval-base seconds and retries, growing
# the wait by net:reconnect-interval-multiplier each time. At a 5 s base those pauses
# dominate a deploy whose actual payload is a few hundred KB. Shared hosting refuses
# connections routinely (per-user caps, throttling), so this path is HOT, not
# exceptional. 2 s recovers just as reliably at a fraction of the wall clock, and
# pinning the multiplier to 1 stops a couple of refusals compounding into 20 s waits.
set net:max-retries 5
set net:timeout 40
set net:reconnect-interval-base 2
set net:reconnect-interval-multiplier 1
set net:persist-retries 5
set xfer:clobber on
# --ignore-time: compare by SIZE only (the staged copies all have mtime=now, so
# a time compare would try to re-send everything; size compare re-sends exactly
# the files whose bytes changed AND any remote file left truncated by a prior run).
# PARALLEL IS OFF BY DEFAULT — I turned it on at 3 and that was the wrong call for
# this host. FTP's cost really is per-file round trips, so concurrency looks like the
# obvious win, but shared hosting caps concurrent connections per user: the extra
# connections get REFUSED, and lftp's recovery for a refusal is the multi-second
# sleep configured above. That trades a fast transfer for a guaranteed wait. Try
# DEPLOY_PARALLEL=3 if you want to measure it; if the run shows reconnect delays,
# the cap is real and 1 is correct.
mirror --reverse --verbose --ignore-time --parallel=${DEPLOY_PARALLEL:-1} "$STAGE_DIR/" "$REMOTE_DIR/"
# Force-upload the credentials file explicitly — guarantees js/config.js
# lands even if the mirror diff ever decides to skip it. Without config.js
# the deployed app can't sign in to Google Drive.
mkdir -p "$REMOTE_DIR/js"
put -O "$REMOTE_DIR/js" "$STAGE_DIR/js/config.js"
# Force-upload the ?v=DEPLOYVER–stamped files. The stamp is always a 14-digit
# timestamp, so a stamp-only change keeps the file the EXACT SAME SIZE — and the
# the mirror --ignore-time above compares by SIZE ONLY, so it SKIPS them, freezing
# the cache-bust stamp and serving stale JS/CSS to returning (mobile) browsers
# forever. Put them explicitly every deploy so the fresh stamp always lands.
mkdir -p "$REMOTE_DIR/js/bloops"
put -O "$REMOTE_DIR"           "$STAGE_DIR/index.html"
# Same force-put, same reason: a stamp-only change is byte-identical in length
# and the size-only mirror would skip it.
put -O "$REMOTE_DIR"           "$STAGE_DIR/bloops.html"
put -O "$REMOTE_DIR"           "$STAGE_DIR/player.html"
put -O "$REMOTE_DIR"           "$STAGE_DIR/artwork.html"
put -O "$REMOTE_DIR"           "$STAGE_DIR/game.html"
put -O "$REMOTE_DIR"           "$STAGE_DIR/tracks.html"
put -O "$REMOTE_DIR/js/bloops" "$STAGE_DIR/js/bloops/03b-core-voices.js"
# RETIRED PAGES. The mirror above is --reverse WITHOUT --delete, so deleting a
# file from the repo never removes it from the server — it just stops being
# updated and sits there serving its last version forever. These two were the
# earlier site's Listen and Watch pages; their nav pointed at a homepage that
# no longer exists. rm -f is idempotent, so this is safe to leave in place.
rm -f "$REMOTE_DIR/listen.html"
rm -f "$REMOTE_DIR/watch.html"
# Post-upload SIZE VERIFICATION of the big JS the app can't boot without —
# a size mismatch vs the local staged copy means a truncated upload.
echo "--- remote sizes (verify vs local) ---"
ls -l "$REMOTE_DIR/js/bloops/17-ambient.js"
ls -l "$REMOTE_DIR/js/bloops/03-audio-bus-fx.js"
ls -l "$REMOTE_DIR/js/bloops/core/bloops-dsp.wasm"
bye
EOF

echo ""
_phase "upload"
echo ""
echo "🎵 Deployment complete in $((SECONDS / 60))m $((SECONDS % 60))s."
echo "🔎 Verify the credentials reached the server:"
echo "    open https://<your-domain>/js/config.js — it should show your real"
echo "    clientId/apiKey, not a 404. Then hard-refresh the app (Cmd-Shift-R)."

