#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Fall back to an nvm-installed Node when the default one is older than required.
if ! node scripts/check-node.mjs >/dev/null 2>&1; then
  for bin in "$HOME/.nvm/versions/node"/*/bin; do
    if [ -x "$bin/node" ] && "$bin/node" scripts/check-node.mjs >/dev/null 2>&1; then
      export PATH="$bin:$PATH"
      break
    fi
  done
fi
node scripts/check-node.mjs

echo "cloud-agent-start: node $(node -v) ready."
