# Polyth Extension Platform

Polyth extensions add capabilities, actions, data, and bounded user interface while Polyth retains ownership of rendering, permissions, tenant isolation, lifecycle, and navigation.

This document describes the public managed-extension surface implemented by `@polyth/package-sdk` and `@polyth/plugins`. It does not describe first-party workspace feature packages, which continue to use `polyth.serverEntry`, `polyth.webEntry`, `@polyth/plugins`, and `@polyth/web-sdk` directly.

## Core model

A managed extension has three distinct layers:

1. **Manifest metadata** is parsed without starting extension code. It describes identity, runtime class, contributions, capabilities, and connections.
2. **Sandbox runtime** is loaded only when a contribution needs live extension code. It runs in a script-only sandbox frame with no host DOM, network, stylesheet, image, form, or local-resource access.
3. **Host mediation** performs privileged work and renders all public extension UI. Extension code communicates through typed MessagePort RPC, structured results, and RemoteUI.

A remotely installed sandboxed extension cannot declare a trusted server entry. Trusted-local execution is a separate install/runtime class and is accepted only from an explicitly trusted local source.

## Manifest versions

`manifestVersion: 1` remains readable. Its surfaces and composer actions normalize into the same managed runtime used by v2.

Use `manifestVersion: 2` for the extension contribution graph. The host does not maintain a second v2 execution stack; both versions normalize into the same package registry, Space-scoped grant store, lifecycle, sandbox runtime, and slot/surface infrastructure.

A minimal v2 manifest:

```json
{
  "manifestVersion": 2,
  "id": "sample-extension",
  "version": "1.0.0",
  "display": {
    "name": "Sample extension",
    "description": "Adds a native Polyth action."
  },
  "runtime": {
    "kind": "sandboxed",
    "ui": { "entry": "src/index.ts" }
  },
  "contributes": {
    "messageActions": [
      { "id": "capture", "label": "Capture", "roles": ["assistant"] }
    ]
  }
}
```

Contribution ids are stable package-local ids. The host namespaces their runtime registrations by package identity and rejects duplicate ids within a contribution kind.

## Contributions

v2 currently parses and integrates these contribution kinds:

| Contribution | Host integration | Runtime activation |
| --- | --- | --- |
| `surfaces` | Polyth package surface | when opened |
| `composerActions` | composer action seam | when invoked |
| `attachmentProviders` | composer Add menu + native picker overlay | when opened |
| `messageActions` | native message-action seam | when invoked |
| `sessionActions` | native session action seam | when invoked |
| `commands` | native `/` command discovery and host overlay | when invoked |
| `toolRenderers` | conversation tool-result seam | none for declarative; lazy for dynamic |
| `statusBadges` | session status seam | only while visible/live |
| `settingsSections` | package settings integration seam | while visible |
| `contextProviders` | native context/provider seam | when opened |
| `widgets` | Polyth widget catalog | while rendered |

Every contribution is bounded by parser limits for count, ids, titles, descriptions, and contribution-specific metadata.

### Message and tool authority

The browser never supplies authoritative selected-message text or tool output to an extension invocation.

For message actions and dynamic tool renderers the browser sends only the canonical event sequence. The server re-reads that exact event from the canonical session log, verifies the session belongs to the current Space, validates the declared role/matcher, bounds the payload, and only then creates an invocation lease.

This keeps a one-message action from becoming implicit permission to read an entire session.

## Slash commands

A v2 `commands` contribution participates in the normal Polyth `/` discovery UI rather than introducing a second command picker. Discovery is resolved per request from the current Space: only enabled, ready, sandboxed packages in that Space contribute commands.

Command-name precedence is deliberately conservative:

1. project commands;
2. user commands;
3. Polyth built-ins;
4. extension commands;
5. native runtime commands.

Installing a package therefore cannot silently take over an existing project, user, or built-in command name.

When an extension command wins, the browser carries a host-reserved opaque command id. Immediately before normal session admission, Polyth re-resolves the current installed package and exact contribution, launches the same host-owned contribution overlay used by other extension actions, and removes the temporary optimistic composer echo.

Extension slash commands are **host actions, not model turns**. A successful invocation does not create a canonical `user/message`, prompt-history entry, model turn, durable send operation, queue item, or local send-recovery intent. If the package was disabled, removed, updated incompatibly, or the contribution disappeared after autocomplete discovery, launch fails before session admission and the normal rejected-send path restores the draft.

The invocation payload contains only bounded command data: the typed query is capped at 1,000 characters and arguments at 4,000 characters, plus the host-owned Space/package/generation/contribution identity. It does not grant session-history access.

Attachment pills cannot be mixed into an extension command submission. Returned resources/context use the normal extension result path and become ordinary Polyth attachments after the command runs.

## Invocation leases

User-driven contribution execution uses host-generated invocation authority rather than a permanent broad capability.

Each lease is:

- opaque to the extension;
- bound to package id;
- bound to Space;
- bound to the exact installed package generation;
- bound to one contribution id and kind;
- bound to the selected session/message/tool/resource identity where applicable;
- short-lived (two minutes for interactive UI);
- consumed once on completion;
- revoked when the package is disabled, reloaded, updated, rolled back, or removed.

The server stores only a hash of the lease token. Completion payloads are validated before the lease is consumed. Replays, wrong-package use, wrong-Space use, stale package generations, and expired leases fail closed.

## Capabilities and grants

Capabilities are declared in the manifest and granted per Space. A grant in one Space never grants the same authority in another Space.

A declaration may set `required: false`. Optional authority does not block activation; code must check `host.hasCapability(name)` before using it. Package review grants required authority by default; optional authority is a separate explicit user choice.

Capabilities currently backed by host behavior include the UI/composer/session/project metadata surfaces, structured context/resources, package storage, brokered network access, connections, clipboard access, and bounded utility-model generation exposed by the current SDK catalog.

Sensitive capabilities use constraints where implemented. Examples include:

- HTTPS origin allowlists for `network.fetch`;
- optional HTTP-method restrictions for network calls;
- model class and maximum output-token limits for `model.generate`.

Update review compares authority, not only capability names. Expanding an allowlist, removing a previous bound, or increasing a bounded model budget is an authority expansion and requires review before the candidate version can activate.

## Connections and network access

Connections are host-owned credential handles. Extension code never receives a raw credential through the SDK.

A connection declaration defines:

- stable connection id;
- user-facing label;
- connection kind;
- approved HTTPS origin set;
- OAuth public metadata when applicable.

Connection definitions are fingerprinted per Space. A target change invalidates the previous approval and blocks candidate activation until reviewed.

`network.fetch` is brokered by Polyth. Redirects and final origins remain subject to the broker policy. A connection credential may only be attached to an origin approved by both the connection definition and the active capability grant.

## Structured resources and context

Extensions exchange external data through `ExternalResource` and `StructuredContext` rather than unrelated text conventions.

`ExternalResource` carries stable provider/resource identity, title, optional URL, summary/text, freshness, metadata, and provenance.

`StructuredContext` carries provider/source identity, title, optional URI, retrieval/freshness times, human summary, model-visible content, and metadata.

Contribution results are runtime-validated and size-bounded. External URLs are HTTPS-only and may not embed credentials.

The web host turns returned resources/context into normal Polyth Markdown attachments with their provenance included. They use the existing attachment pipeline and therefore retain Polyth's normal composer chips, remote-workspace delivery behavior, and model-visible history rules.

Direct `context.append` is reserved for explicitly granted context authority. Appended package context is persisted through the canonical session event path before it becomes model-visible.

## RemoteUI

Sandboxed extensions do not mount React components into the host realm and do not send arbitrary HTML/CSS as their normal UI contract.

RemoteUI v2 currently supports host-rendered primitives including:

- stack and inline layout;
- text and headings;
- button;
- text input and textarea;
- select, checkbox, and radio group;
- badges and cards;
- lists and list items;
- bounded tables;
- Markdown rendered by the Polyth Markdown renderer;
- code;
- progress and spinner;
- separator and empty state.

RemoteUI rejects unknown child nodes and enforces limits on node count, depth, string size, options, table dimensions, and update rate. Action/id values use a restricted identifier vocabulary.

There is no raw HTML node, arbitrary CSS, arbitrary script URL, or unrestricted remote-image primitive.

Full-tree render updates remain the supported protocol. Keyed incremental patches are not exposed because current dynamic examples do not justify a second diff/resynchronization protocol.

## Tool rendering

Tool rendering has two levels.

### Declarative presentation

A renderer may declare a tool-name matcher plus title/subtitle templates and an output mode (`auto`, `text`, `json`, `markdown`, `code`, or `table`). This path is rendered directly by the host and does not activate the sandbox runtime.

### Dynamic presentation

A renderer marked `dynamic: true` receives a bounded canonical tool event under an invocation lease and may return RemoteUI.

Dynamic renderer failure is isolated. The canonical Polyth tool activity remains visible; a renderer cannot make the underlying conversation unreadable.

## Lifecycle and performance

Installing an extension loads manifest/contribution metadata only.

Sandbox code activates when a live contribution needs it. Runtime instances are ref-counted and disposed when their contribution unmounts. Disable/update/uninstall tears down package runtimes, listeners, MessagePorts, timers, pending invocations, and slot registrations.

Plugin bridge reconciliation carries a package generation fence so stale async loading cannot re-register an older version after a newer generation wins.

Declarative tool renderers have zero sandbox-runtime activation cost.

## Updates and rollback

Managed updates use the existing staged-version model:

1. stage the candidate separately;
2. parse the manifest;
3. validate required assets;
4. build sandbox/trusted assets as appropriate;
5. compute integrity;
6. compare capabilities and connection fingerprints in every enabled Space;
7. refuse trust-class escalation through a remote update;
8. wait for any required review;
9. switch the active pointer and activate;
10. keep the previous version available for rollback.

If activation fails, the active pointer is restored and the previous runtime is restarted when needed. A failed download/stage never destroys the healthy active version.

## Installation sources

The existing HTTPS/ZIP installation path and explicitly enabled trusted development/local paths remain supported.

A general Git source mode is intentionally not exposed. A secure implementation would need explicit policy for redirects, internal/private hosts, hooks, submodules, repository configuration, credentials, mutable refs, disk/time limits, filters, and symlinks. The current platform prefers the existing staged HTTPS/ZIP path over an incomplete Git execution surface.

## SDK entry point

Extension runtime code imports only `@polyth/package-sdk`:

```ts
import { connectPolyth } from "@polyth/package-sdk";

const polyth = await connectPolyth();

polyth.contributions.onInvoke(async (invocation) => {
  if (invocation.kind !== "message-action") return;
  return {
    message: `Selected ${invocation.message.role} message`,
  };
});
```

Host/test-only protocol helpers remain on the host subpath and are not required by extension authors.

## CLI

```sh
polyth-package validate ./my-extension
polyth-package doctor ./my-extension
polyth-package pack ./my-extension
```

`validate` checks the manifest and required assets. `doctor` adds developer-facing diagnostics for dynamic contributions without a runtime entry, missing assets, optional authority, connection/capability mismatches, and declarative zero-runtime rendering. `pack` creates the installable archive.

## Examples

Repository examples using only the public SDK:

- `examples/task-provider-extension` — native picker, resource/context provider, message action, session action, and command contribution;
- `examples/tool-renderer-extension` — declarative and dynamic tool rendering with fallback;
- `examples/utility-extension` — native settings, Space-scoped storage, and optional utility-model generation.

A package-sdk test rejects private Polyth imports in these examples.

## Remote and mobile behavior

The public contracts do not assume that the UI device and the workspace execution host are the same machine. Selected project/session identities cross the host boundary; filesystem or model authority remains host-mediated.

Current sandbox execution is browser-hosted. Additional runtime placements are not advertised as manifest functionality until they have a complete secure execution path.

Because UI is rendered by Polyth, RemoteUI inherits the host's mobile sheets/dialogs, touch targets, theme, typography, density, reduced-motion preferences, focus handling, and semantic controls.

## Deliberately unsupported public surfaces

The following are not public extension capabilities today:

- arbitrary host React components from sandboxed extensions;
- arbitrary iframe HTML/CSS as the primary extension UI API;
- trusted process/server execution acquired through a remote package update;
- project file read/write APIs without the complete root/symlink/scope broker;
- arbitrary provider credentials;
- Git install sources;
- incremental RemoteUI patch protocol;
- runtime placement modes that have not been implemented and secured.

Do not add manifest fields for these until the host behavior, policy, limits, tests, lifecycle, and user experience all exist.

## Security checklist for extension authors

Before shipping an extension:

- request only authority used by a real code path;
- make optional features optional permissions;
- use invocation payloads instead of broad session reads for selected-item actions;
- keep external data bounded and provenance-aware;
- declare only exact network origins required;
- use host connections instead of collecting credentials in extension UI;
- treat project/session/tool content as untrusted data;
- return cleanup for any package-side subscription;
- handle capability denial and offline/network failures without blocking the host UI;
- run `polyth-package doctor` and the package SDK tests before packing.
