# Known OpenCode issues and protocol limitations

Observed against OpenCode CLI `1.18.18`.

| ID | Class | Finding | Polyth behavior |
| --- | --- | --- | --- |
| U1 | OpenCode bug | `read` on a nonexistent path can remain running indefinitely. | Keeps the turn active/unknown and does not replay the prompt. |
| U2 | OpenCode bug | Aborting a running bash tool can record `completed` with a null exit while the side effect did not occur. | Issues one abort and preserves the upstream terminal payload; presentation cannot safely correct it. |
| U3 | OpenCode bug | `ProviderModelNotFoundError` can include internal Bun bundle stack frames. | Persists the failure without exposing configured secret values. |
| U4 | OpenCode bug | A client-supplied session ID collision can return another project location from one shared service. | Location-scoped bindings remain mandatory; shared-product attach stays disabled. |
| P1 | Protocol ambiguity | Legacy create/prompt does not reliably echo an exact operation receipt. | Response loss remains `unknown`; mutations are not retried or adopted by similarity. |
| P2 | Protocol ambiguity | Legacy idle/error events have no comparable revision and status lists only busy sessions. | Live events use admitted-turn scope; unchanged reconnect history cannot fabricate a terminal. |
| P3 | Protocol ambiguity | V2 event replay/cursor semantics and durable fields are inconsistent or optional. | Replay and resumable cursors remain disabled. |
| P4 | Protocol ambiguity | OpenCode exposes no authoritative shared-service descriptor with instance identity, credentials, and continuity. | Normal product composition does not borrow a shared daemon. |
| P5 | Protocol ambiguity | File prompt parts can be rewritten as synthetic text in durable history. | Exact attachment-history fork verification may fail closed. |
| P6 | Protocol ambiguity | Occupied-port startup may report generic `ServeError` instead of a stable bind code. | Unrecognized startup failures remain explicit rather than guessed. |

## Remaining Polyth limitations

- The normal runtime pool cannot select a discovered shared V2 daemon.
- SSH ControlMaster loss still couples the local forward and remote child.
- Some SSE drop/replay cases with changed transport identities can produce
  duplicate model-visible facts.
- Worktree fork mapping and generation-rotation recovery are incomplete.
- JSONC comments are lost on the first genuine managed config rewrite.
- A full 24-hour / 10,000-turn soak has not been run.

These limitations are not waived by deterministic tests or past validation
runs.
