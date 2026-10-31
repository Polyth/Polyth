# Playground

`@polyth/playground` owns Polyth's chat-driven live prototype surface. It composes the existing native session, file/resource and workbench contracts; it does not own a model runtime, duplicate Chat, or import another feature package's private UI.

## Enabled by the user, not by default

The package ships **disabled** (`polyth.descriptor.enabled: false`). Until a user
enables it, no web entry is imported, so it contributes no surface, workbench
profile, capability or widget — the header keeps no Playground tab and no
Playground lane exists. Package enablement stays owned by `packages.json`
seeded from the descriptor; the web host simply never loads the entry for a
disabled package.

The descriptor only seeds `packages.json` on first boot, so an existing install
that already recorded `playground: true` keeps it enabled; "off by default"
applies to a fresh data directory, exactly as for every other optional package.

A user turns it on the same way any other optional package is turned on:
`Settings → Packages` (Workspace group). Project configuration
(`ProjectCompositionEditor`) still lists Playground, marked
`Disabled globally`, because a disabled package is deliberately not filtered out
of the project view — but it offers no per-project choice until the package is
enabled globally. Package enablement is a stronger boundary than project
relevance and the project view must not be able to reopen it.

Its workbench profile keeps `projectAffinity: { directions: ["engineering",
"research"], recommended: true }`, so a typed project that includes it can still
seed Playground as the initial profile.

## Canonical artifact

Each canonical session owns `.polyth/playground/<session-id>/index.html`. The path helper validates the canonical UUID; preview, selection context and work-chat handoff use the same path. Existing project-global artifacts remain untouched and are not automatically assigned to a session.

Playground always uses the current `projectId` plus the current `sessionId` with the Files API. That keeps reads and source navigation on the canonical session worktree when the session is isolated instead of accidentally previewing the main checkout.

The artifact is self-contained HTML/CSS/JavaScript by default. This is intentionally a zero-build path: the first useful version must work with every harness and on projects that do not have Node, Vite, a framework dev server or a browser package runtime.

New Playground chats carry immutable `purpose: "playground"`; the package profile declares the matching `sessionPurpose`. The host routes sessions to their owning profile and keeps session lists, remembered chats and new-chat drafts separate. This is a workbench conversation boundary within the current authenticated Space, not a new tenant or a filesystem access-control boundary. Legacy sessions without a purpose remain ordinary chats; opening Playground does not relabel an existing conversation.

The package registers its instructions through the server's `SESSION_PURPOSES` lifecycle seam. Every admitted user turn persists that context before runtime delivery, while the visible chat retains only the user's request. There is no initialization model turn, local “armed” flag, or Resync step. The model receives the session-specific artifact path on the first request and subsequent turns, including after runtime recovery. Forks preserve the purpose but receive their own artifact path; a fork does not automatically copy artifact files.

When assets are needed, the agent should inspect and prefer suitable project assets by default. External images, fonts, libraries, and other resources require an explicit user request; network access remains off by default.

## Workbench and live refresh

Playground is its own workbench mode/profile, with its own profile-scoped conversation and the package-owned live surface. On wide shells the profile places native `session` on the inline-start side and `playground` on the inline-end side; the host keeps the standard pane separator so the result can be resized. `Swap windows` exchanges the two profile placements without remounting either surface. While the mode is active, the sidebar uses its project-rail presentation with the selected project's worktree/session pane kept visible beside the rail, so projects and branch navigation remain primary. The host still owns geometry and phone/tablet presentation. The legacy capability remains searchable in More and does not create a duplicate primary rail action.

### Work-chat handoff

`Send to work chat` creates a bounded implementation brief containing the source Playground session id, canonical artifact path, selected element (when present), and a bounded artifact snapshot. If the conversation profile already has a session, the brief is sent there and queued when that session is busy. If it has no session, Playground activates the conversation profile and places the same brief into a fresh work-chat draft. Success and rejection are shown in the Playground surface; no handoff is treated as successful merely because activation was attempted.

The preview polls `filesStat` and fetches raw bytes only when the artifact revision changes. Active agent turns use a faster stat interval; hidden/inactive surfaces back off. Responsive, desktop, tablet and mobile controls change only the preview viewport, not global shell geometry.

Element Select runs through a tiny injected bridge inside the preview. The parent accepts bridge messages only from the current iframe window. A selected element can be inserted into the normal composer as bounded selector/tag/text context; the package does not synthesize or send the user's edit request. The selection can also be included in the explicit work-chat handoff.

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
npm run build:web
node --experimental-strip-types --test packages/playground/test/playground.test.ts
```

The web build verifies package discovery/browser bundling and the package test covers per-turn asset guidance and per-session artifact paths, bounded handoff context, selected-element context and offline/HTTPS CSP modes. Real visual sign-off still requires opening the package in a running Polyth instance and checking the Playground mode's project rail, default chat/result order, swap control, resize separator, and narrow/mobile fallback.
