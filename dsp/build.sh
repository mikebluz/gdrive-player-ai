#!/bin/bash
# Build bloops-dsp to WASM and install it where the app serves it.
set -e
cd "$(dirname "$0")"
PATH="$HOME/.cargo/bin:$PATH" cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/bloops_dsp.wasm ../js/bloops/core/bloops-dsp.wasm
echo "installed -> js/bloops/core/bloops-dsp.wasm"
