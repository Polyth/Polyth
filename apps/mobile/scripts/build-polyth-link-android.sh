#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TOOLCHAIN="${POLYTH_RUST_TOOLCHAIN:-1.91.0}"
CARGO_NDK_VERSION="${POLYTH_CARGO_NDK_VERSION:-4.1.2}"
OUT="$ROOT/apps/mobile/android/app/src/main/jniLibs"

command -v rustup >/dev/null 2>&1 || { echo "rustup is required" >&2; exit 1; }
if ! rustup toolchain list | grep -q "^${TOOLCHAIN}"; then
  rustup toolchain install "$TOOLCHAIN" --profile minimal
fi
rustup target add --toolchain "$TOOLCHAIN" aarch64-linux-android x86_64-linux-android

if ! cargo ndk --version 2>/dev/null | grep -q "${CARGO_NDK_VERSION}"; then
  cargo install cargo-ndk --version "$CARGO_NDK_VERSION" --locked
fi

rm -rf "$OUT"
mkdir -p "$OUT"
cargo "+$TOOLCHAIN" ndk \
  --platform 24 \
  -t arm64-v8a \
  -t x86_64 \
  -o "$OUT" \
  build \
  --manifest-path "$ROOT/Cargo.toml" \
  -p polyth-link-uniffi \
  --release
