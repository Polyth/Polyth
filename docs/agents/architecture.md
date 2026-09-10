# Architecture and ownership map

This is a compact navigation model, not a complete call graph. **Normative constraints** come from AGENTS; **observed entry points** come from source inspection and the evidence registry; directory-only coverage is explicitly marked there. Read current definitions before editing.

## Data and execution path

A user action enters shared web/mobile UI, calls the canonical HTTP/WS surface, resolves authorization/Space context and reaches a scoped service. Canonical session logic admits the action and records durable state. A selected backend supplies an AgentRuntime. Native observations are normalized, reconciled and persisted before broadcast; UI projects the canonical result. Native IDs do not replace Polyth session IDs.

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
| `session-import` | Generic snapshot orchestration | importer and snapshot tests; native readers stay in providers |
| `tunnel` / `pairing-qr` / Link crates | Remote access product / ticket encoding / protocol-native layers | Link architecture and current remote policy |
| Feature packages | Package-owned services, routes, content, settings, widgets | manifest, serverEntry/webEntry, own tests |

Feature group navigation: files/editor/git; models/opencode/commands; goals/multirun/fusion/walkthrough/workflow; knowledge/schedule/usage; browser/dictation/terminal/ssh; code-hosting/github/gitlab ([hosting architecture](../architecture/gitlab-support.md)); home-assistant/task-trackers/custom-action; chat-workspace/handoff; permissions/secure-safe. This grouping describes intent, not complete integration/readiness or a list of packages guaranteed present forever. `inventory` reads actual manifests.

## Integration contracts to protect

`polyth.serverEntry` is discovered independently from web activation. Registration is not dependency-sorted, so cross-package service lookup must be lazy. `ServerPackage` includes route and lifecycle hooks; remote policy omission denies paired access. `host.forSpace` and `host.spaceStorage` are the supported tenant seams. Direct store append does not automatically broadcast; `host.events.append` does.

A browser feature uses `defineWebPackage`, returns cleanup and leaves global geometry to the host. The usage entry demonstrates settings/surfaces/widgets/capabilities registration. Import allowlists remain in their executable containment test, not copied into this document. CodeMirror remains editor-owned and lazy.

A package root may contain Node-only imports. The commands package exposes `./catalog` separately from its Node-backed root. Never generalize a convenient sibling export pattern into a rule for the whole workspace.

## What this map intentionally does not freeze

It does not pin a capability table, route inventory, package count, test count, model list, protocol version or private server address. Consult source and installed versions. Historical switch/Snapshot design is useful, but old numeric limits and supported-feature tables must be checked against current constants and adapters.
