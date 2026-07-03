#!/bin/bash
# Build bloops-dsp to WASM and install it where the app serves it.
set -e
cd "$(dirname "$0")"
PATH="$HOME/.cargo/bin:$PATH" cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/bloops_dsp.wasm ../js/bloops/core/bloops-dsp.wasm
echo "installed -> js/bloops/core/bloops-dsp.wasm"
# Golden-render gate: non-fatal here (a deliberate DSP change fails until its
# re-baseline), but always visible so accidental drift can't ship silently.
node ../test/golden-render.js || echo "^ golden drift — intentional? re-baseline: node test/golden-render.js --update"
