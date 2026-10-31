---
name: polyth-agent-beta
description: Launch a disposable Polyth web UI for agent-driven interface and interaction testing with host harnesses and a read-only workspace.
---

# Agent beta UI

Use this for live UI/UX or interaction checks from the current Polyth checkout/worktree. The beta instance has its own temporary Polyth data, no browser login, and inherits the host PATH/HOME so installed harnesses and their existing authentication remain available. Workspace reads are allowed; native edit/write and shell mutation paths are blocked.

## Start

```bash
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
mkdir -p .scratch/agent-beta
npm run build:web
nohup node --experimental-strip-types scripts/agent-beta.ts --no-build   > .scratch/agent-beta/runtime.log 2>&1 &
echo $! > .scratch/agent-beta/launcher.pid

until grep -q '^POLYTH_AGENT_BETA_READY ' .scratch/agent-beta/runtime.log; do
  kill -0 "$(cat .scratch/agent-beta/launcher.pid)" 2>/dev/null || {
    cat .scratch/agent-beta/runtime.log
    exit 1
  }
  sleep 0.2
done
grep '^POLYTH_AGENT_BETA_READY ' .scratch/agent-beta/runtime.log | tail -1
```

Open the reported loopback URL with the browser and test the real web UI. The beta UI runs unlocked: a direct-loopback status request mints one reusable owner session for that browser, so there is no lock screen and no login. Change beta settings freely. Do not replace `POLYTH_DATA_DIR`, expose the listener publicly, or try to bypass a beta read-only denial.

## Cleanup

```bash
kill "$(cat .scratch/agent-beta/launcher.pid)" 2>/dev/null || true
for _ in $(seq 1 50); do
  kill -0 "$(cat .scratch/agent-beta/launcher.pid)" 2>/dev/null || break
  sleep 0.1
done
rm -rf .scratch/agent-beta
```

The launcher owns the beta server and deletes its temporary data directory on exit.
