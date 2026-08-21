# UX runtime baseline

- Case: `UX-TIMELINE-LAYOUT-01`
- Bootstrap model / role: `SOL` / reference auditor
- Recorded: `2026-08-21`
- Repository root: `/workspace`
- Source revision: `b63b6c887726896739ead8fc021320f8db52bed8`

## Current isolated Polyth runtime

| Item | Value |
|---|---|
| Build path | `/tmp/polyth-ux-timeline-layout-01-b63b6c8` |
| Data path | `/tmp/polyth-ux-timeline-layout-01-data` |
| URL / port | `http://127.0.0.1:4492` / `4492` |
| Health | `GET /api/health` returned `200` with `ok:true`, version `0.1.0` |
| Persistent process | tmux session `polyth-ux-timeline-layout-01` |
| Synthetic project | `Timeline Layout Audit Fixture` |
| Synthetic session | `Synthetic timeline layout audit` |
| Direct session URL | `http://127.0.0.1:4492/p/db081417-e2a9-4920-8c42-19d757b6fc93/s/timeline-layout-audit` |

Port `4492` was confirmed free before launch. The existing service on port
`4400` was not stopped, replaced, or modified.

## Build and launch

The clean source tree was produced with `git archive HEAD` and built in the
isolated path:

```sh
NODE_OPTIONS=--experimental-strip-types npm ci
NODE_OPTIONS=--experimental-strip-types npm run build
```

The persistent server was launched from that build with:

```sh
OPENCODE_BIN="$(dirname "$(command -v opencode)")"
NPM_GLOBAL_BIN="$(npm prefix -g)/bin"
HOME=/tmp/polyth-ux-timeline-layout-01-home \
XDG_CONFIG_HOME=/tmp/polyth-ux-timeline-layout-01-home/.config \
XDG_DATA_HOME=/tmp/polyth-ux-timeline-layout-01-home/.local/share \
NODE_OPTIONS=--experimental-strip-types \
PORT=4492 \
POLYTH_DATA_DIR=/tmp/polyth-ux-timeline-layout-01-data \
PATH="$OPENCODE_BIN:$NPM_GLOBAL_BIN:$PATH" \
npm start
```

## Browser verification and timeline access

Google Chrome loaded the direct session URL from the built bundle at
`1280×900`, `768×900`, `390×844`, and `320×844`. The synthetic five-turn
conversation, reasoning disclosure, message times/actions, timeline scrollport,
and composer all rendered. No real conversation or provider credential was
used. If a fresh browser presents workspace setup first, complete or skip that
browser-local step and reopen the direct session URL.

Evidence:

- `/opt/cursor/artifacts/polyth_timeline_overlap_preobserve_desktop.png`
- `/opt/cursor/artifacts/polyth_timeline_overlap_preobserve_768.png`
- `/opt/cursor/artifacts/polyth_timeline_overlap_preobserve_390.png`
- `/opt/cursor/artifacts/polyth_timeline_overlap_preobserve_320.png`

The runtime and its tmux process are intentionally left running for downstream
auditors.
