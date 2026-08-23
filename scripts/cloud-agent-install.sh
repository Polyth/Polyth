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

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

npm run build

echo "cloud-agent-install: dependencies installed and web bundle built."
