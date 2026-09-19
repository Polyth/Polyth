# Playground

`@polyth/playground` owns Polyth's chat-driven live prototype surface. It composes the existing native session, file/resource and workbench contracts; it does not own a model runtime, duplicate Chat, or import another feature package's private UI.

## Canonical artifact

The live artifact is `.polyth/playground/index.html`.

Playground always uses the current `projectId` plus the current `sessionId` with the Files API. That keeps reads and source navigation on the canonical session worktree when the session is isolated instead of accidentally previewing the main checkout.

The artifact is self-contained HTML/CSS/JavaScript by default. This is intentionally a zero-build path: the first useful version must work with every harness and on projects that do not have Node, Vite, a framework dev server or a browser package runtime.

Enabling Playground sends one model-visible, chat-hidden session instruction through the canonical session message path. The normal Polyth composer remains the user conversation surface. The instruction only routes design/prototype requests to the canonical artifact; clearly unrelated requests remain ordinary chat. Resync is explicit because runtime recovery or aggressive context compaction can require the instruction to be re-established.

## Workbench and live refresh

The `playground` workbench profile places native `session` in the primary region and the package-owned `playground` surface in the end region. The host still owns geometry and phone/tablet presentation.

The preview polls `filesStat` and fetches raw bytes only when the artifact revision changes. Active agent turns use a faster stat interval; hidden/inactive surfaces back off. Responsive, desktop, tablet and mobile controls change only the preview viewport, not global shell geometry.

Element Select runs through a tiny injected bridge inside the preview. The parent accepts bridge messages only from the current iframe window. A selected element can be inserted into the normal composer as bounded selector/tag/text context; the package does not synthesize or send the user's edit request.

## Preview security boundary

The artifact runs in an iframe with `sandbox="allow-scripts"` and never receives `allow-same-origin`.

A CSP injected ahead of artifact content blocks external network resources and connections by default, plus frames, objects, form submissions and base navigation. The user may explicitly enable HTTPS resources/connections for a prototype; the iframe remains sandboxed and Polyth does not pass credentials into it.

The network toggle is a preview convenience, not a general egress firewall. Generated prototypes must not read credentials, call Polyth APIs or intentionally target private/local services. Do not place secrets in a Playground artifact.

## Relationship to Browser

Playground is the zero-build artifact loop. `@polyth/browser` remains the controlled Chromium surface for real sites, dev servers, DOM/browser actions, screenshots and shared user/agent browser state.

Do not import Browser's private widget implementation into Playground. A future full-project/dev-server mode should use a reviewed public lifecycle seam rather than duplicating process spawning or reaching across package boundaries.

## Verification

Relevant checks:

```sh
npm ci --no-audit --no-fund
npm run build:web
node --experimental-strip-types --test packages/playground/test/playground.test.ts
```

The web build verifies package discovery/browser bundling and the package test covers the bootstrap, selected-element context and offline/HTTPS CSP modes. Real visual sign-off still requires opening the package in a running Polyth instance and checking desktop plus narrow/mobile workbench presentation.
