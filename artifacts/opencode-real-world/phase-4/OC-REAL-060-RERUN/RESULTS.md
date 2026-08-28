# OC-REAL-060 / 061 current-code rerun

Validated 2026-08-28 against real OpenCode `1.18.18`, forced legacy protocol,
isolated data/config directories, and ports 15260/15261 (never 14500).
Every crash targeted one recorded PID after `/proc` identity verification.

| Scenario | Verdict | Evidence |
| --- | --- | --- |
| OC-REAL-060 | **PASS** | Polyth died while its owned wrapper, real OpenCode child, and turn were alive. Durable authority stayed `owned:11ec6254-f313-48f6-93fc-fa198e9db174`, generation advanced 1→2, first-wire abort returned 200 in 30 ms, and stale `working` settled to honest `unknown`. One prompt POST, one durable user intent, one side effect; SQLite `ok`. |
| OC-REAL-061 | **PASS** | Real OpenCode died mid-turn, then Polyth died 150 ms later; Polyth restarted first and OpenCode second. Durable authority stayed `owned:33e51e32-bd28-4c2c-a707-407e502bdd64`, generation advanced 1→2, first-wire abort returned 200 in 29 ms, and stale `reconciling` settled to honest `unknown`. One prompt POST, one durable user intent, one side effect; WAL/SQLite `ok`. |

The initial OC-REAL-060 rerun reproduced the remaining failure after authority
persistence: generation advanced, but `packages/server/src/sessions.ts` rejected
the persisted generation before reconciliation. Commit `cc508d3d` allows only
same-authority/same-protocol/same-location owned bindings to move to the current
generation at the server reattachment boundary. Runtime lifecycle calls and
callbacks remain generation-fenced.

Files:

- `manifest.json`, `details.json`, and `verdict.json`: final OC-REAL-060 rerun.
- `../OC-REAL-061-RERUN/`: final OC-REAL-061 rerun.
- `rerun.mjs`: exact reusable driver for both cases.
- Raw process, wire, fault, and SQLite evidence is under matching
  `logs/opencode-real-world/phase-4/OC-REAL-0NN-RERUN/` directories.
