# Chat Workspace

`@polyth/chat-workspace` is a project-scoped workspace for external AI chat web apps. It intentionally differs from the agent-controlled Browser package: Chat Workspace pages are user-owned, persistent, and `manual-only`. Polyth agents do not receive generic observation, DOM extraction, inspection, or control of these pages.

## Current remote runtime

The existing runtime is server-owned:

1. `ChatWorkspaceService` owns project/workspace metadata and uses the Browser package `ProfileRegistry`.
2. persistent Chromium profiles run where the Polyth server runs;
3. CDP JPEG screencast frames are sent to `ChatWorkspaceViewport`;
4. the web UI renders those frames into a canvas;
5. mouse, wheel and keyboard input are relayed back to the server.

This remains a supported fallback for web/mobile clients and explicitly selected remote execution. It is not the desired Desktop default because every interaction and rendered frame crosses the network.

## Target Desktop runtime

Desktop Chat Workspace is local-first:

```text
canonical Polyth host                    Polyth Desktop
--------------------                    --------------
project/workspace state                 dedicated Chromium
runtime selection             <---->    persistent provider profiles
permissions / audit                     cookies + login state
session handoff                          native local rendering/input
metadata                                 provider adapters
           ^                                  |
           | authenticated worker WebSocket  |
           +--------- Polyth Link ------------+
```

The host remains the control/state plane. The Desktop application is the browser execution plane.

Local mode must not use the JPEG/canvas path. Typing, scrolling, text selection, provider animations, clipboard interaction and browser rendering happen on the Desktop device.

### Runtime policy

`selectChatWorkspaceRuntime()` implements the package policy:

- prefer a capable Desktop runtime;
- never silently start the remote runtime when the requested local device is unavailable;
- remote fallback is used only when explicitly allowed;
- explicit `remote` mode remains available.

A disconnected local device therefore produces a waiting/unavailable state rather than moving the user's provider login into a server Chromium profile without consent.

## Device worker protocol

`deviceRuntimeProtocol.ts` defines the logical host ↔ Desktop worker protocol. It deliberately does **not** define a second network or pairing mechanism. The protocol rides Polyth Link.

The worker advertises:

- local Chromium availability;
- local rendering;
- persistent local profiles;
- explicit response handoff support.

The host may send metadata-only commands such as ensuring a profile/tab, activation, navigation, close and pin state. The worker returns tab metadata, errors and explicit handoffs.

The following data is forbidden on this boundary in local-rendering mode:

- cookies;
- browser storage state;
- local/session storage;
- arbitrary DOM/HTML;
- screencast frames/pixels/screenshots;
- clipboard contents.

`assertSafeDeviceProtocolPayload()` exists as defense in depth for future serializers/tests.

## Desktop transport

Polyth Link already provides the required authenticated transport. The shared `polyth-link-client` creates an authenticated loopback proxy to the canonical host and proxies WebSockets as well as HTTP. A Desktop worker can therefore open a package-owned worker WebSocket through that proxy. The connection is client-initiated, but once established it is bidirectional, so the host can dispatch runtime commands over the existing authenticated connection without adding a reverse-RPC transport to Link.

The worker channel must remain narrow:

1. the Desktop Link client pairs/authenticates normally and receives its existing `deviceId`;
2. Desktop opens the Chat Workspace worker WebSocket through the Link loopback origin;
3. the server binds the socket to the live paired-device principal;
4. the worker sends the protocol hello/capabilities;
5. host commands and worker events use `deviceRuntimeProtocol.ts` messages;
6. Space/project ownership is rechecked before dispatch;
7. request IDs, bounded timeouts and a connection generation prevent stale work after reconnect;
8. grant revocation closes the socket through the existing paired-socket lifecycle.

Do not add an ad-hoc public socket, bearer token, generic Electron RPC, filesystem bridge, shell bridge, or Node bridge for Chat Workspace.

The remaining Desktop integration work is to run/use the shared Link client in Desktop worker mode and expose this package-owned WS, not to create a new transport protocol.

## Profiles and credentials

Browser profile metadata may remain part of canonical workspace state, but local Chromium profile data is device-local.

In local mode:

- cookies and provider credentials stay on the Desktop device;
- Chromium user-data directories are never synchronized through Polyth storage;
- an existing remote profile stays usable only in remote mode;
- switching execution device may require signing in on that device;
- runtime ownership must be visible rather than silently migrating credentials.

## External LLM → Polyth handoff

The package reuses `@polyth/handoff`; it must not introduce a competing context/session store.

Explicit user actions may transfer selected/provider-response text to:

- the current Polyth session;
- the current session queue while an agent is working;
- a new Polyth session;
- other registered Handoff destinations.

The current remote canvas path can obtain user-selected text through the existing manual clipboard/copy endpoint. Desktop local mode should extract the selection/response locally and send only the explicit handoff object.

Every imported item carries provenance such as provider/profile and is paired with the resulting user message through the existing Handoff provenance machinery.

### Manual-only invariant

Provider adapters may inspect the local provider DOM only to satisfy a trusted explicit user action, for example:

- `Add to agent`;
- `Ask agent`;
- `New chat`;
- `Save to project knowledge` when that capability is available.

An agent may not request arbitrary Chat Workspace extraction. No generic `read Claude conversation`/`inspect ChatGPT page` capability is added.

## Provider adapters

Provider-specific DOM knowledge is isolated in `providerAdapters.ts`. Adapters prefer semantic/provider-owned selectors and must feature-detect at runtime.

A provider DOM change must degrade by hiding inline actions or falling back to selection handoff. It must not break the provider page or Chat Workspace itself.

The Desktop browser integration should add small Polyth actions beside completed assistant-message controls and a selection toolbar. These controls must be visually quiet and provider-native in density. They are Polyth-owned trusted UI/actions; provider pages must never receive a privileged general-purpose Polyth bridge.

## Rollout order

1. Keep the server runtime behind the existing behavior.
2. Land runtime selection and device protocol contracts/tests.
3. Add a package-owned paired-device worker WebSocket reachable through the existing Polyth Link proxy.
4. Integrate the shared Link client with Desktop worker lifecycle/pairing.
5. Implement Desktop-local persistent Chromium execution using the already staged Playwright Chromium.
6. Replace canvas/screencast with a local browser surface in Desktop mode.
7. Wire provider adapters and response-end actions inside the local trusted integration.
8. Preserve explicit remote fallback for web/mobile/unattended cases.
9. Validate Desktop local mode and remote fallback separately before changing the default.
