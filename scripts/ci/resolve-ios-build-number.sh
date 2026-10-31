#!/usr/bin/env bash
set -euo pipefail

if [ -z "${APP_STORE_APPLE_ID:-}" ]; then
  echo "APP_STORE_APPLE_ID must be set in the ios_config Codemagic environment group" >&2
  exit 1
fi

if ! [[ "$APP_STORE_APPLE_ID" =~ ^[0-9]+$ ]]; then
  echo "APP_STORE_APPLE_ID must be a numeric App Store Connect application ID" >&2
  exit 1
fi

if [ -z "${CM_ENV:-}" ]; then
  echo "CM_ENV is not set; cannot export POLYTH_IOS_CURRENT_PROJECT_VERSION" >&2
  exit 1
fi

query_latest() {
  local command_name="$1"
  local output=""
  local exit_code=0

  set +e
  output="$(app-store-connect "$command_name" --silent "$APP_STORE_APPLE_ID")"
  exit_code=$?
  set -e

  if [ "$exit_code" -ne 0 ]; then
    echo "$command_name failed with exit code $exit_code" >&2
    exit 1
  fi

  if [ -z "$output" ]; then
    echo 0
    return
  fi

  if ! [[ "$output" =~ ^[0-9]+$ ]]; then
    echo "$command_name returned unexpected non-numeric stdout" >&2
    exit 1
  fi

  echo "$output"
}

latest_testflight="$(query_latest get-latest-testflight-build-number)"
latest_appstore="$(query_latest get-latest-app-store-build-number)"

latest="$latest_testflight"
if [ "$latest_appstore" -gt "$latest" ]; then
  latest="$latest_appstore"
fi

next=$((latest + 1))
echo "App Store Connect latest build number: $latest -> $next"
echo "POLYTH_IOS_CURRENT_PROJECT_VERSION=$next" >> "$CM_ENV"
