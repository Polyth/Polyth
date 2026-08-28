# Phase 9 — scaled soak

This is a scaled dense soak, **not a 24-hour claim**. Real OpenCode
`1.18.18` ran for 10.1
minutes of automated churn on forced legacy protocol, port 15290 (never
14500), with 24 sessions and 253 unique logical
messages.

## Verdicts

Post-run analysis reclassified 33 identical HTTP 409 queue admissions after the owned-child generation change as expected fail-closed safety behavior. No transport or unexpected HTTP error occurred; the raw runner output is retained with the run logs.

| ID | Verdict | Result |
| --- | --- | --- |
| OC-REAL-084 (scaled) | **PASS** | 24 sessions, 253 logical messages, 120 resource samples, 117 model refreshes, 117 client reconnects, one Polyth restart, and one owned-child restart. No monotonic non-data resource leak crossed the bounded thresholds. |
| OC-REAL-085 | **NOT RUN** | The Phase 2 mutation-loss proxy was not composed into this ownership soak. Process death/replacement was exercised, but no response-loss verdict is claimed. |
| OC-REAL-086 (scaled) | **PARTIAL** | 205 durable FIFO rows survived child + Polyth restart and drained through exact queue-row removals with zero rows left. Automatic FIFO execution and recurring permission/question stress were not completed because of the already-documented real legacy terminal-evidence gap, so full queue-dispatch acceptance is not claimed. |
| OC-REAL-087 (scaled) | **PARTIAL** | One isolated project/runtime was churned through owned-child and Polyth replacement with exact PID/cwd checks. Worktree, second-project, SSH, and config-batch churn were not included. |

## Measurements

- Polyth late-window RSS: 130152 → 133376 KiB
  (growth 3224 KiB; min 130152,
  max 133376).
- Polyth late-window descriptors: 36 → 38
  (growth 2); sockets: 11 →
  13 (growth 2).
- Event-log footprint: 5627576 bytes total; rows:
  {"events":1527,"projections":24,"runtime_operations":97,"session_queue":0,"observations":811,"attention_open":0}.
- Session load latency: p50 1.7 ms, p95
  2.2 ms, max 2.8 ms.
- WebSocket reconnect/gap-fill latency: p50 1.6
  ms, p95 2.5 ms, max
  7.3 ms.
- Model refresh latency: p50 3 ms, p95
  3.6 ms.

## Invariants

- **PASS** — scaled soak reached duration target: churnMs=607145 targetMs=600000
- **PASS** — dense churn reached the duration-or-turn target with many sessions: sessions=24 logicalMessages=253 churnMs=607146
- **PASS** — model refresh and reconnect churn accumulated: modelRefreshes=117 websocketReconnects=117
- **PASS** — owned child restart completed without stale owned process: {"atElapsedMs":201644,"before":{"wrapperPid":144006,"childPid":144014,"realPort":4096,"proxyPort":46867,"startedAt":"2026-08-28T08:36:00.773Z"},"killedIdentity":{"pid":144014,"state":"S","parentPid":144006,"startIdentity":"1986687","executable":"/home/ubuntu/.opencode/bin/opencode","command":"/home/ubuntu/.local/bin/opencode serve --hostname 127.0.0.1 --port 0","cwd":"/tmp/ocreal/phase-9/scaled-mtcp5xea/project"},"after":{"wrapperPid":144643,"childPid":144651,"realPort":4096,"proxyPort":35327,"startedAt":"2026-08-28T08:39:26.968Z"},"oldWrapperGone":true,"oldChildGone":true,"queueRowsBefore":205,"queueRowsAfter":205}
- **PASS** — Polyth restart completed with first-wire session access: {"atElapsedMs":366594,"killed":{"pid":143982,"state":"S","parentPid":143944,"startIdentity":"1986644","executable":"/home/ubuntu/.nvm/versions/node/v22.22.2/bin/node","command":"/home/ubuntu/.nvm/versions/node/v22.22.2/bin/node /workspace/artifacts/opencode-real-world/phase-4/tools/boot-polyth.mjs","cwd":"/workspace"},"beforeState":{"wrapperPid":144643,"childPid":144651,"realPort":4096,"proxyPort":35327,"startedAt":"2026-08-28T08:39:26.968Z"},"wrapperBefore":{"pid":144643,"state":"S","parentPid":143982,"startIdentity":"2007310","executable":"/home/ubuntu/.nvm/versions/node/v22.22.2/bin/node","command":"node /workspace/artifacts/opencode-real-world/phase-4/tools/shim-proxy.mjs serve --hostname 127.0.0.1 --port 35327","cwd":"/tmp/ocreal/phase-9/scaled-mtcp5xea/project"},"childBefore":{"pid":144651,"state":"S","parentPid":144643,"startIdentity":"2007314","executable":"/home/ubuntu/.opencode/bin/opencode","command":"/home/ubuntu/.local/bin/opencode serve --hostname 127.0.0.1 --port 0","cwd":"/tmp/ocreal/phase-9/scaled-mtcp5xea/project"},"survivedCrash":true,"afterState":{"wrapperPid":144867,"childPid":144875,"realPort":4096,"proxyPort":46117,"startedAt":"2026-08-28T08:42:10.137Z"},"firstWireFailures":0,"abortProbe":{"status":200,"body":{"ok":true}},"oldWrapperGone":true,"oldChildGone":true,"queueRowsBefore":205,"queueRowsAfter":205}
- **PASS** — no duplicate direct logical prompt or tool side effect: directCounts=[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1] effects=7 duplicateEffects=0 duplicateUpstream=[]
- **PASS** — wire prompt dispatch is bounded by unique logical messages: promptPosts=48 directMarkers=24 logicalMessages=253
- **PASS** — no session remains stuck sending or working: stuck=[]
- **PASS** — queue rows survived restart in order and drained without row loss: child=205->205 polyth=205->205 beforeDrain=205 dispatched=24 submitted=229 afterDrain=0
- **PASS** — SQLite remains valid: {"dbBytes":1437696,"walBytes":4157112,"shmBytes":32768,"totalBytes":5627576,"integrity":"ok","rows":{"events":1527,"projections":24,"runtime_operations":97,"session_queue":0,"observations":811,"attention_open":0}}
- **PASS** — no orphan owned processes and parent chain remains exact: {"polyth":{"pid":144847,"state":"S","parentPid":143944,"startIdentity":"2023567","executable":"/home/ubuntu/.nvm/versions/node/v22.22.2/bin/node","command":"/home/ubuntu/.nvm/versions/node/v22.22.2/bin/node /workspace/artifacts/opencode-real-world/phase-4/tools/boot-polyth.mjs","cwd":"/workspace"},"wrapper":{"pid":144867,"state":"S","parentPid":144847,"startIdentity":"2023625","executable":"/home/ubuntu/.nvm/versions/node/v22.22.2/bin/node","command":"node /workspace/artifacts/opencode-real-world/phase-4/tools/shim-proxy.mjs serve --hostname 127.0.0.1 --port 46117","cwd":"/tmp/ocreal/phase-9/scaled-mtcp5xea/project"},"child":{"pid":144875,"state":"S","parentPid":144867,"startIdentity":"2023629","executable":"/home/ubuntu/.opencode/bin/opencode","command":"/home/ubuntu/.local/bin/opencode serve --hostname 127.0.0.1 --port 0","cwd":"/tmp/ocreal/phase-9/scaled-mtcp5xea/project"},"scratchProcesses":[{"pid":144867,"state":"S","parentPid":144847,"startIdentity":"2023625","executable":"/home/ubuntu/.nvm/versions/node/v22.22.2/bin/node","command":"node /workspace/artifacts/opencode-real-world/phase-4/tools/shim-proxy.mjs serve --hostname 127.0.0.1 --port 46117","cwd":"/tmp/ocreal/phase-9/scaled-mtcp5xea/project"},{"pid":144875,"state":"S","parentPid":144867,"startIdentity":"2023629","executable":"/home/ubuntu/.opencode/bin/opencode","command":"/home/ubuntu/.local/bin/opencode serve --hostname 127.0.0.1 --port 0","cwd":"/tmp/ocreal/phase-9/scaled-mtcp5xea/project"}],"staleOwnedAlive":[]}
- **PASS** — every forced signal target belonged to this isolated run: [{"label":"owned-opencode-child","signal":"SIGKILL","pid":144014,"state":"S","parentPid":144006,"startIdentity":"1986687","executable":"/home/ubuntu/.opencode/bin/opencode","command":"/home/ubuntu/.local/bin/opencode serve --hostname 127.0.0.1 --port 0","cwd":"/tmp/ocreal/phase-9/scaled-mtcp5xea/project"},{"label":"polyth-process","signal":"SIGKILL","pid":143982,"state":"S","parentPid":143944,"startIdentity":"1986644","executable":"/home/ubuntu/.nvm/versions/node/v22.22.2/bin/node","command":"/home/ubuntu/.nvm/versions/node/v22.22.2/bin/node /workspace/artifacts/opencode-real-world/phase-4/tools/boot-polyth.mjs","cwd":"/workspace"}]
- **PASS** — churn API operations completed without transport or HTTP errors: transport/http errors=0; expected fail-closed post-generation conflicts=33
- **PASS** — no monotonic non-data resource leak detected: lateWindowSamples=20 rssGrowthKb=3224 fdGrowth=2 socketGrowth=2

The final Polyth process and its currently owned OpenCode wrapper/child remain
running for follow-up inspection. Their exact identities and parent chain are
recorded in `live-state.json`. Raw timeline, wire, process, and per-sample
metrics are under `logs/opencode-real-world/phase-9/`.
