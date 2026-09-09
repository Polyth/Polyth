#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TOOLCHAIN="${POLYTH_RUST_TOOLCHAIN:-1.91.0}"
OUT="$ROOT/apps/mobile/ios/App/CapApp-SPM/PolythLinkCore.xcframework"
WORK="$ROOT/target/polyth-link-ios-xcframework"
HEADERS="$ROOT/crates/polyth-link-uniffi/include"

command -v rustup >/dev/null 2>&1 || { echo "rustup is required" >&2; exit 1; }
command -v xcodebuild >/dev/null 2>&1 || { echo "xcodebuild is required" >&2; exit 1; }
command -v lipo >/dev/null 2>&1 || { echo "lipo is required" >&2; exit 1; }

if ! rustup toolchain list | grep -q "^${TOOLCHAIN}"; then
  rustup toolchain install "$TOOLCHAIN" --profile minimal
fi
rustup target add --toolchain "$TOOLCHAIN" \
  aarch64-apple-ios \
  aarch64-apple-ios-sim \
  x86_64-apple-ios

build_target() {
  cargo "+$TOOLCHAIN" build \
    --manifest-path "$ROOT/Cargo.toml" \
    -p polyth-link-uniffi \
    --release \
    --target "$1"
}

build_target aarch64-apple-ios
build_target aarch64-apple-ios-sim
build_target x86_64-apple-ios

rm -rf "$WORK" "$OUT"
mkdir -p "$WORK/simulator"
lipo -create \
  "$ROOT/target/aarch64-apple-ios-sim/release/libpolyth_link_uniffi.a" \
  "$ROOT/target/x86_64-apple-ios/release/libpolyth_link_uniffi.a" \
  -output "$WORK/simulator/libpolyth_link_uniffi.a"

xcodebuild -create-xcframework \
  -library "$ROOT/target/aarch64-apple-ios/release/libpolyth_link_uniffi.a" \
  -headers "$HEADERS" \
  -library "$WORK/simulator/libpolyth_link_uniffi.a" \
  -headers "$HEADERS" \
  -output "$OUT"

node "$SCRIPT_DIR/configure-ios-polyth-link.mjs"
