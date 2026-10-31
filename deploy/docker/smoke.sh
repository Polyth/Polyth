#!/usr/bin/env bash
# Boot smoke test for a built Polyth image: bundled tools are present, a
# first-run setup claim can be issued, and the server answers on loopback.
#
#   deploy/docker/smoke.sh <image> [port]
#
# Uses a throwaway data volume and host networking on the given port
# (default 47400); it never touches an existing Polyth data directory.
set -euo pipefail

IMAGE="${1:?usage: smoke.sh <image> [port]}"
PORT="${2:-47400}"
RUN_ID="polyth-smoke-$$"
VOLUME="$RUN_ID-data"

cleanup() {
  docker rm -f "$RUN_ID" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step() { printf '==> %s\n' "$*"; }

step "bundled tools"
docker run --rm --entrypoint sh "$IMAGE" -ec '
  node --version
  opencode --version
  git --version
  test -x "packages/harness-runtime/native/bin/linux-$(node -p process.arch)/polyth-supervisor"
  test -s apps/web/dist/index.html
  if [ -e "$POLYTH_LINK_HOST" ]; then echo "polyth-link-host: present"; else echo "polyth-link-host: omitted"; fi
  if command -v gh >/dev/null; then gh --version | head -n1; fi
  if [ -n "${POLYTH_CHROMIUM_PATH:-}" ]; then "$POLYTH_CHROMIUM_PATH" --version; fi
'

step "setup claim on a fresh data volume"
docker volume create "$VOLUME" >/dev/null
CLAIM="$(docker run --rm -v "$VOLUME:/data" "$IMAGE" setup-claim)"
printf '%s\n' "$CLAIM" | grep -Eq '"claimToken": "[0-9a-f]{64}"' || {
  echo "setup-claim did not print a claim token" >&2
  exit 1
}

step "server boots on 127.0.0.1:$PORT"
docker run -d --name "$RUN_ID" --network host -e PORT="$PORT" -v "$VOLUME:/data" "$IMAGE" >/dev/null
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$RUN_ID")" != "true" ]; then
    docker logs "$RUN_ID" >&2
    echo "container exited before answering /api/health" >&2
    exit 1
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/api/health"
echo
curl -fsS "http://127.0.0.1:$PORT/" | grep -qi '<html' || {
  docker logs "$RUN_ID" >&2
  echo "web shell was not served" >&2
  exit 1
}
docker logs "$RUN_ID" 2>&1 | tail -n 20

step "graceful stop"
docker stop -t 30 "$RUN_ID" >/dev/null
EXIT_CODE="$(docker inspect -f '{{.State.ExitCode}}' "$RUN_ID")"
[ "$EXIT_CODE" = "0" ] || { docker logs "$RUN_ID" >&2; echo "server exited with $EXIT_CODE on SIGTERM" >&2; exit 1; }

step "ok"
