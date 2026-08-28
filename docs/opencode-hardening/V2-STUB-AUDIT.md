# OpenCode V2 adapter audit

Audited against the live OpenCode `1.18.18` OpenAPI document and loopback server on
2026-08-28. “Implemented” means Polyth has a native `/api/*` wire implementation; it
does not imply replay-safe mutations or complete V2 parity.

## `ProtocolAdapter` surface

| Method | Status | V2 contract |
| --- | --- | --- |
| Health/protocol selection | Implemented outside `ProtocolAdapter` | Generation-scoped read-only probe checks `GET /doc` and `GET /api/health`; a dual-surface `1.18.18` document selects the now-operational V2 adapter. |
| `protocol` | Implemented | Reports `v2`. |
| `capabilities()` | Implemented | No event replay, partial pending snapshots, no idempotent mutations. |
| `models()` | Implemented | Concurrent `GET /api/model` and `GET /api/provider`; validates both envelopes, maps provider connectivity/modalities/variants, and distinguishes true empty from transport/protocol failure. |
| `agents()` | Implemented | `GET /api/agent`; hidden internal agents are omitted. |
| `sessions()` | Implemented | `GET /api/session` with bounded descending `cursor.next` traversal. |
| `history()` | Implemented | Cursor-paged `GET /api/session/{sessionID}/message`; native user/assistant messages become `RuntimeSessionMessage`. Cursor pages omit `order` as required by V2. |
| `eventStreamPath()` | Implemented | Global native SSE at `GET /api/event`. V2 `{id,type,data,durable}` frames are normalized before the existing event reducer. |
| `ensureSession()` | Implemented | `POST /api/session` with `LocationRef` (`workspaceID` in the body); an existing binding remains a no-op confirmation. |
| `resetSession()` | Implemented | Creates a replacement with `POST /api/session`, matching the canonical reset contract. V2 create has no title field. |
| `branchSession()` | Optional, explicit unsupported | No V2 fork/branch route exists in the live document. The legacy `/session/{id}/fork` is not used as a hidden fallback. |
| `submit()` | Implemented | Optional `POST .../model` and `POST .../agent`, then `POST /api/session/{id}/prompt` with `delivery: "queue"`. |
| `steer()` | Implemented | `POST /api/session/{id}/prompt` with `delivery: "steer"`. |
| `abort()` | Implemented | `POST /api/session/{id}/interrupt`. |
| `deleteSession()` | Optional, explicit unsupported | No V2 session delete route exists. Unregistered V2 paths may return SPA HTML, so Polyth does not probe by mutation. |
| `replyPermission()` | Implemented | `POST /api/session/{id}/permission/{requestID}/reply` with `{reply}`. |
| `replyQuestion()` | Implemented | `POST /api/session/{id}/question/{requestID}/reply` with `{answers}`, or `/reject`. |
| `reconcile()` | Implemented, partial | Pulls session, active state, recent messages, global pending permissions, and global pending questions. Running is positive evidence; unversioned absence from active remains `unknown`. |

## Reconciliation sources

- `GET /api/session/{id}` verifies the binding still resolves.
- `GET /api/session/active` supplies positive running evidence.
- `GET /api/session/{id}/message?limit=1000&order=asc` supplies recent consolidated
  messages for pull recovery.
- `GET /api/permission/request` and `GET /api/question/request` supply location-wide
  pending requests, filtered by session ID.

Events, permissions, and questions remain marked `partial`: these snapshots do not carry
enough causal evidence to close an unknown mutation or prove a terminal state from
absence alone.

## Former deliberate stubs

The pre-fix adapter deliberately returned `[]` for models, agents, and sessions; returned
no event-stream path; and rejected all mutations as capability-unsupported. All
upstream-backed core session placeholders are removed. No CORE capability remains stubbed
for health/protocol selection, discovery, session create/list/hydrate, model/agent
selection, prompt/steer, SSE, abort, active status, permission, or question handling.

The only `ProtocolAdapter` methods left as typed unsupported are branch and delete,
because the audited live V2 document has no corresponding operation.

## Reviewed but intentionally unsupported

The live document also exposes compaction/wait, staged revert, shell, TUI, installation
upgrade, OAuth/integration, and other control-plane routes. They are not represented by
`ProtocolAdapter` methods and remain outside this blocker. Polyth does not infer support,
silently call legacy routes, or report successful empty values for them.
