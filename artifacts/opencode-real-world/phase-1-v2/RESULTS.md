# Phase 1 V2 / shared-service real OpenCode revalidation

Validation date: 2026-08-28
Polyth starting SHA: `bf80e1b5ba2376030cd6f6eef126591953e54018`
OpenCode: `1.18.18`, binary SHA-256
`bb71f45b564f9234a97f54d6252a4a41d2f4388ae4b078918f691824cc3b3e54`
Node: `/home/ubuntu/.nvm/versions/node/v22.22.2/bin/node` (`v22.22.2`)
Standalone reference: `http://127.0.0.1:46303`, PID `32127`, isolated root
`/tmp/polyth-oc-phase1-v2-current-4`

This replaces the result written at `95a0422a`, when the V2 adapter was a stub. All
current conclusions were re-executed against real OpenCode. Endpoints were loopback-only;
authorization values were redacted.

## Verdict

| ID | Result | Current finding |
| --- | --- | --- |
| OC-REAL-026 | **FAIL** | The old permanent stub/empty result is superseded. Stable auto V2 returned 68 models, 4 agents, and confirmed create/prompt. Fresh forced-V2 and both fresh product runs nevertheless returned a first empty catalog; later stable reprobes returned 68. Normal product sessions persisted `protocol=legacy`, remained `unknown`, and rejected prompt with HTTP 409. Forced legacy returned 7,382 models and confirmed create. |
| OC-REAL-027 | **PASS (negative)** | `1.18.18` still has `--mdns` and `attach <url>`, but no authoritative descriptor or `serve --service`; SDK declarations expose `createOpencodeServer({url,close})`, not discovery/ensure/stop. |
| OC-REAL-028 | **BLOCKED** | Closest-supported injected descriptors proved Basic auth on real REST/SSE and stale credentials returned 401. Official discovery-driven rotation is absent. |
| OC-REAL-029 | **BLOCKED** | Injected replacement changed URL/auth and generation 1→2 atomically. With honest `generation-only` continuity, an old binding failed `binding-mismatch` before mutation. Official continuity and active callback testing remain unavailable. |
| OC-REAL-030 | **FAIL** | Borrowed library attach works; normal boot still only creates owned runtimes. Pointing normal boot at the live shared port returned 503 `ServeError` instead of attaching, while the shared PID survived. |
| OC-REAL-031 | **BLOCKED** | Borrowed dispose left PID `32127` healthy and an independent SSE client connected. Product shutdown acceptance is blocked because product boot cannot select borrowed mode. |
| OC-REAL-032 | **BLOCKED** | Reattach now lists surviving sessions, superseding the stale `sessions: []` finding. History and reconcile fail HTTP 400 because Polyth sends `limit=1000` to a live endpoint capped at 200; direct `limit=200` succeeds. Product attach and authoritative continuity are still absent. |
| OC-REAL-033 | **FAIL** | Models, agents, list, create/reset, prompt/steer, interrupt, SSE/replay, attachments, and missing attention replies reached native `/api/*`. Fork/delete are correctly explicit unsupported. History/reconcile are broken by the 1,000/200 limit mismatch, fresh catalogs can be falsely empty, and facade capability flags overclaim unavailable work. |

Counts: **1 pass, 3 fail, 4 blocked**.

## What changed from the stale result

- V2 is no longer a mutation/history stub: create, reset, prompt, steer, interrupt, session
  list, global/session SSE, and permission/question reply routes made real wire calls.
- Stable model discovery is populated: V2 returned 68 enabled models from `google` and
  `opencode`; agent discovery returned `build`, `plan`, `general`, and `explore`.
- Borrowed reconnect now lists real sessions.
- Fork and delete still have no V2 route, but Polyth now returns stable
  `capability-unsupported` without fake success or legacy fallback.
- The original empty-catalog cause is superseded, but fresh-child readiness still reproduced
  a transient empty catalog: forced V2 returned zero before the same service stabilized at
  68, and normal product auto/forced-V2 each returned zero on their first query.

## Remaining product gaps

1. V2 history, hydrate, and reconcile request `limit=1000`; OpenCode rejects message limits
   above 200. Native `limit=200` returned the durable user, attachment, and failed-assistant
   records.
2. The normal server's runtime-pool facade does not forward `protocol()`. Both auto and
   forced-V2 product sessions therefore persisted `protocol=legacy`, stayed `unknown`, and
   rejected send with `cannot send while the session is unknown`.
3. Normal boot cannot select a borrowed/shared endpoint. Occupied-port startup rejects with
   a generic 503 rather than attaching.
4. Fresh V2 catalog readiness is not stabilized; a successful transient `data: []` is
   treated as authoritative.
5. The facade reports streaming, permissions, questions, compaction, subagents, and steering
   as universally true. Real `wait` and `compact` returned explicit 503
   `ServiceUnavailableError`.
6. An in-root file was admitted with its exact file URI. An out-of-root path was silently
   omitted while the prompt still confirmed; traversal should be rejected pre-I/O.
7. There is no V2 config operation. Raw `/api/config` falls through to HTTP 200 SPA HTML,
   while legacy `/config` returns JSON.
8. OpenCode exposes no authoritative discovery/auth/instance/continuity descriptor.

## Execution coverage

- Prompt admission and SSE worked. One run emitted model/agent switch, prompt admission,
  step-started, and step-failed events; native history recorded the provider failure.
- A second 243-second run admitted five Google prompts but emitted no text, reasoning, tool,
  question, permission, completed, or interrupted events. Therefore thinking, tools, live
  attention, normal completion, and comparable interruption remain unproved, not passed.
- Session replay returned 15 events; reconnect with `after=2` returned 13.
- Missing permission/question replies returned explicit 404. Interrupt returned 204.
- SQLite integrity was `ok`; normal owned children were stopped, while the shared PID stayed
  alive through borrowed dispose and all product shutdowns.

## Evidence

- Main wire/adapter/product/SQLite/ownership evidence:
  `logs/opencode-real-world/phase-1-v2/current-validation.json`
- Long-running execution probe:
  `logs/opencode-real-world/phase-1-v2/current-agent-capabilities.json`
- Injected auth/rotation probe:
  `logs/opencode-real-world/phase-1-v2/current-auth-rotation.json`
- Stable model reprobe:
  `logs/opencode-real-world/phase-1-v2/current-stable-model-reprobe.log`
- Current CLI/process/health:
  `logs/opencode-real-world/phase-1-v2/current-opencode-*.txt`,
  `current-shared-process.txt`, and `current-shared-health.json`
