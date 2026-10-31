# Architecture and ownership map

This is a compact navigation model, not a complete call graph. **Normative constraints** come from AGENTS; **observed entry points** come from source inspection and the evidence registry; directory-only coverage is explicitly marked there. Read current definitions before editing.

## Data and execution path

A user action enters shared web/mobile UI, calls the canonical HTTP/WS surface, resolves authorization/Space context and reaches a scoped service. Canonical session logic admits the action and records durable state. A selected backend supplies an AgentRuntime. Native observations are normalized, reconciled and persisted before broadcast; UI projects the canonical result. Native IDs do not replace Polyth session IDs.

If a runtime emits a completed assistant message without a terminal turn event, the session service checks the same bound runtime after a quiet interval. Only authoritative reconciliation may close the canonical turn; the OpenCode facade also clears its local active-turn state when that pull proves a terminal native state. Normal terminal events cancel the delayed check. A reconciliation snapshot may ingest the native `turn/stopped` itself (the live copy then arrives fenced as stale evidence); the session service must still release its in-memory active turn, run the stop's completion hooks and dispatch the queue. Admission, queue dispatch and Stop also release an active turn whose `turn/stopped` is already durable, so a stop recorded outside the live handler can never leave every send queued behind a finished turn.

OpenCode V2 reconciliation may treat its active-session listing as stale when the latest durable assistant answer is completed and no native tool, permission or question remains open. A newer user message or unfinished tool keeps the turn running.

Reconciliation orders each observed runtime status against the durable status checkpoint. A checkpoint with no comparison domain (for example a bare `running` observation from an adapter that cannot version the active-session map) cannot outrank freshly observed versioned evidence; rejecting it would leave the session `unknown` and its queued work permanently undelivered. The accepted state rewrites the checkpoint with its comparison so later reads stay ordered.

This path explains why an attachment defect can be picker, upload, canonical DTO, capability admission, native translation or rendering—not automatically “the model does not support files.” Likewise a disconnected channel says nothing by itself about whether a mutating tool already executed.

## Owners and seams

| Owner | Responsibility | Start here |
| --- | --- | --- |
| `apps/web` | Shared shell, registries, state projection, primitives, tokens | current source plus `packageContainment.test.ts` |
| `apps/mobile` | Capacitor client shell, native integration, connection UI | `src/runtime.ts`, `nativeBridge.ts`, `polythLink.ts` |
| `apps/desktop` | Electron main/preload, local server lifecycle, packaging | app manifest and desktop guide |
| `contracts` | Public DTOs/events/interfaces and selected runtime exports | actual exported symbol, not an assumed type-only barrel |
| `kernel` | Capability contexts, contribution/effect lifecycle | package source; change only for a proven core need |
| `plugins` | Server discovery, package host/services, remote policy seam | `src/serverPackage.ts` |
| `web-sdk` | Supported feature UI registration contract | `src/index.ts` plus one current caller |
| `tenancy` | Space/security/storage boundary | tenancy source and Space design |
| `session` / `server` | Canonical log/projection, admission, HTTP/WS composition | owning service plus session/runtime regression tests |
| `harness-runtime` / `backend-*` | Shared runtime machinery / provider translation | current registry/adapter and protocol tests |
| `session-import` | Generic snapshot orchestration and the single project-menu import surface | importer and snapshot tests; native readers stay in providers |
| `tunnel` / `pairing-qr` / Link crates | Remote access product / ticket encoding / protocol-native layers | Link architecture and current remote policy |
| Feature packages | Package-owned services, routes, content, settings, widgets | manifest, serverEntry/webEntry, own tests |

Feature group navigation: files/editor/git; models/opencode/commands; goals/multirun/fusion/walkthrough/workflow; knowledge/agents/usage; browser/dictation/terminal/ssh; code-hosting/github/gitlab; task-trackers/custom-action/handoff; permissions/secure-safe (Credential Vault). This grouping describes intent, not complete integration/readiness or a list of packages guaranteed present forever. `inventory` reads actual manifests.

Home Assistant is not an in-repository package: it runs as the external managed plugin `home-assistant`, which owns its server, routes, widgets and strings. The host keeps only id-keyed hooks (settings navigation and search, the onboarding tour, permission labels), the `polyth.homeAssistant` capability id and the `HomeAssistant*` DTOs in `@polyth/contracts`, which that plugin imports — do not remove them as unused.

## Integration contracts to protect

`polyth.serverEntry` is discovered independently from web activation. Registration is not dependency-sorted, so cross-package service lookup must be lazy. `ServerPackage` includes route and lifecycle hooks; remote policy omission denies paired access. `host.forSpace` and `host.spaceStorage` are the supported tenant seams. Direct store append does not automatically broadcast; `host.events.append` does.

Session orchestration may register durable many-to-many completion watches through the server `session.watches` service. Watches are keyed by canonical Polyth session ids, scoped to one Space, driven from persisted `turn/stopped` events rather than polling, and replay a bounded durable cursor after restart. Wake delivery enters the target through the canonical session send/queue path; one-shot watches are the default, wake cycles are rejected, and retriable provider-capacity stops do not count as a final outcome. A person's pause is reported as `paused` to every watch for `aborted` (or `paused`) and leaves even a one-shot watch armed; a Stop on the paused session (`session/pause-ended{outcome:"stopped"}`) is its `aborted`, and wakes addressed to a paused session wait until its pause ends. Agents cannot continue a paused session: `session.send` to it is refused. Harness-facing `session.watch`/`session.watches`/`session.unwatch` and `agent.spawn(... watchCaller=true)` (armed by default for an isolated spawn) are orchestration surfaces over that same primitive. Agent-to-chat messages use the polyth tool's `session.send` over the same canonical send path: `delivery` is `queue` by default (wait behind the target's current turn), `interrupt` (stop that turn, run next) or `steer` (join the running turn); the result names the `outcome` (`started`/`queued`/`interrupting`/`steered`), and interrupt/steer refuse the caller's own session.

Wake admissions retain their client operation identity when queued behind a running mutation, so a lost acknowledgement cannot duplicate the notification. A failed `agent.spawn` prompt acknowledgement preserves the child's completion watch because admission may already have happened; `session.unwatch` or canonical session deletion removes an unwanted watch explicitly.

A browser feature uses `defineWebPackage`, returns cleanup and leaves global geometry to the host. The usage entry demonstrates settings/surfaces/widgets/capabilities registration. Import allowlists remain in their executable containment test, not copied into this document. CodeMirror remains editor-owned and lazy.

A package root may contain Node-only imports. The commands package exposes `./catalog` separately from its Node-backed root. Never generalize a convenient sibling export pattern into a rule for the whole workspace.

## What this map intentionally does not freeze

It does not pin a capability table, route inventory, package count, test count, model list, protocol version or private server address. Consult source and installed versions. Historical switch/Snapshot design is useful, but old numeric limits and supported-feature tables must be checked against current constants and adapters.
