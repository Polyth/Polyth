# Polyth Extension Platform

Polyth extensions add capabilities, actions, data, and bounded user interface while Polyth retains ownership of rendering, permissions, tenant isolation, lifecycle, and navigation.

This document describes the public managed-extension surface implemented by `@polyth/package-sdk` and `@polyth/plugins`. It does not describe first-party workspace feature packages, which continue to use `polyth.serverEntry`, `polyth.webEntry`, `@polyth/plugins`, and `@polyth/web-sdk` directly.

## Core model

A managed extension has three distinct layers:

1. **Manifest metadata** is parsed without starting extension code. It describes identity, runtime class, contributions, capabilities, and connections.
2. **Sandbox runtime** is loaded only when a contribution needs live extension code. It runs in a script-only sandbox frame with no host DOM, network, stylesheet, image, form, or local-resource access.
3. **Host mediation** performs privileged work and renders all public extension UI. Extension code communicates through typed MessagePort RPC, structured results, and RemoteUI.

A remotely installed sandboxed extension cannot declare a trusted server entry. Trusted-local execution is a separate install/runtime class and is accepted only from an explicitly trusted local source.

Trusted managed server entries receive shared services bound to their installed
manifest id, including the `harness.capabilities` registry. Capability ids must
use that package's namespace; caller-supplied owners cannot impersonate another
package. The host exposes `managedPackageServices` only to the package manager,
which resolves the view at native activation and passes it to the entry. The
manager's own owner-bound registry cannot be rebound for a child (a bound
registry cannot be bound again), the manager rejects a delegated view bound to
any other id, and managed entries never receive the delegation factory. Capability registrations must be
disposed with the entry's lifecycle.

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

Direct `context.append` is reserved for explicitly granted context authority. Appended package context is persisted through the canonical session event path before it becomes model-visible: the next prompt carries every `package/context` appended since the previous prompt to the runtime (see [workflows](workflows.md#chat-execution)).

## RemoteUI

Sandboxed extensions do not mount React components into the host realm and do not send arbitrary HTML/CSS as their normal UI contract. They describe a `RemoteUiNode` tree and Polyth renders it with its own primitives, so an extension inherits the host's theme, typography, density, touch targets, focus handling, reduced-motion preference, mobile sheets and dialogs without matching them itself.

The author-facing types (`RemoteUiNode`, `RemoteUiType`, `RemoteUiAction`) are exported from `@polyth/package-sdk`. The tree parser and the exported limit constants (`REMOTE_UI_MAX_NODES`, `MAX_DEPTH`, `MAX_STRING`, `MAX_UPDATES_PER_SEC`) live on the host subpath (`@polyth/package-sdk/host`); the option and table bounds are enforced but not re-exported, and an extension does not need any of them.

### Rendering

```ts
import { connectPolyth, type RemoteUiNode } from "@polyth/package-sdk";

const polyth = await connectPolyth();
let note = "";

const tree = (): RemoteUiNode => ({
  type: "stack",
  gap: "md",
  children: [
    { type: "heading", level: 2, text: "Notes" },
    { type: "textarea", label: "Note", value: note, action: "note.edit" },
    { type: "button", label: "Save", variant: "primary", action: "note.save" },
  ],
});

polyth.ui.onAction("note.edit", (action) => {
  if (typeof action.value === "string") note = action.value;
});

await polyth.ui.render(tree()); // requires the ui.render capability
```

- `ui.render` requires the `ui.render` capability from the manifest and the grant review.
- Every call replaces the whole tree. There is no patch protocol, no keyed diff and no partial update; render the whole tree again.
- A rejected or throttled render leaves the last valid tree on screen. The call rejects instead (invalid tree: `INVALID_REQUEST`, over the rate limit: `HOST_REJECTED`).
- The tree is runtime state, not session history: it lives in memory for the active runtime and is gone when that runtime is disposed, at which point the surface shows the host's waiting state.
- The payload must be plain JSON (no functions or DOM nodes), and the whole request must stay under 256 KiB.
- A contribution may return `ui` inside its `ContributionResult`. It is parsed by the same rules and replaces the tree of that contribution's overlay, so a short-lived result does not need a separate `render` call.

### Actions

A node dispatches only when it has an `action`. `host.ui.onAction(id, handler)` registers the handler; it returns an unsubscribe function, and all handlers are dropped with the runtime.

| Node | Emitted action |
| --- | --- |
| `button`, `listItem` | `{ id }` |
| `checkbox` | `{ id, value: boolean }` |
| `select`, `radioGroup` | `{ id, value: option.value }` |
| `input`, `textarea` | `{ id, value: string }` |

- Text fields emit 150 ms after the last keystroke and on blur (blur emits the current value even when nothing changed). A single-line `input` also emits immediately on Enter; `textarea` Enter inserts a newline, so it reports on the debounce or on blur. Drop stale values by comparing with your own state, not by assuming one action per edit.
- Several nodes may share one action id; then there is one handler and the node must be told apart by `action.value` or by separate ids.
- Action ids and node ids must match `^[A-Za-z0-9._:-]{1,128}$`. An action id that does not match is **silently dropped**: the control renders but never dispatches.
- Node `id` is not dispatched. It only gives `children` a stable identity (React key) and names the Markdown render instance.

### State is controlled

Polyth renders what the tree says. It never keeps the new value itself, so a control that ignores its action stays visually stuck.

- `checkbox`, `select` and `radioGroup` have no local state: until the extension renders again with the new `checked`/`value`, the control keeps showing the old one.
- `input` and `textarea` keep the person's keystrokes while the field is focused and accept an external `value` when it is not. A render that omits the change reverts the field, and blur emits the visible text.
- The usual shape is: handle the action, update package state, `render(tree())` again. Batch a burst of state changes into one render; renders are capped at 10 per second per runtime (shared with `ui.toast`), and the extra call is rejected rather than queued.

### Node reference

| `type` | Rendered as | Fields used |
| --- | --- | --- |
| `stack` | vertical group | `children`, `gap` (`sm`/`md`/`lg`, default `md`) |
| `inline` | horizontal group; wraps, and stacks below a ~36rem container | `children`, `gap` (`sm`/`md`/`lg`, default `sm`) |
| `text` | paragraph | `text`, `tone` |
| `heading` | section title: `level` 1 → `h2`, 2 (default) → `h3`, 3 → `h4` | `text`, `level` |
| `button` | small host button | `label` (falls back to `text`), `variant`, `disabled`, `action` |
| `input` | single-line host text field | `value`, `label` (aria-label), `placeholder`, `disabled`, `action` |
| `textarea` | multi-line field, 3–10 rows, auto-growing | same as `input` |
| `select` | labelled host select | `value`, `options`, `label` or `title`, `placeholder`, `disabled`, `action` |
| `checkbox` | host checkbox | `checked`, `label` (falls back to `text`), `subtitle` (description), `disabled`, `action` |
| `radioGroup` | fieldset of radios | `value`, `options` (`label`, optional `detail`), `label` (legend), `disabled`, `action` |
| `badge` | status pill | `text` (falls back to `label`), `tone` |
| `card` | bordered block | `title`, `subtitle`, `body`, `children`, `trailing` |
| `list` | vertical list container | `children` (`listItem`) |
| `listItem` | row; with `action` the whole row is a full-width button, otherwise a static row | `title` (falls back to `label`), `subtitle`, `trailing`, `disabled`, `action` |
| `table` | bounded table; with neither `columns` nor `rows` it renders nothing, and `rows` without `columns` rejects the render | `columns` (required once rows exist, 1–12), `rows` (≤100, each row exactly `columns.length` cells) |
| `markdown` | Polyth's sanitized Markdown renderer | `body` (falls back to `text`), `id` |
| `code` | preformatted block, no syntax highlighting | `text` (falls back to `body`), `language` (a `data-language` label) |
| `progress` | host progress bar | `progress` (`0`…`max`, `max` default `1`), `label` |
| `spinner` | indeterminate busy indicator | `label` |
| `separator` | rule | — |
| `empty` | compact empty state | `title`, `body` (falls back to `subtitle`) |

Fields are shared across nodes and ignored where a node does not use them:

- `tone`: `muted`/`faint`/`success`/`warning`/`danger`/`info`. `text` honours all except `info` (which renders as normal text, as do unknown values); `badge` maps `success`, `warning`, `danger` and `info`, everything else is neutral.
- `variant` is only for `button`: `primary`, `ghost`, or `danger`. Omitted (and `ghost`) renders the quiet default — the renderer has no separate ghost look.
- `trailing` is only for `card` and `listItem`, and only `{ type: "badge" | "text", text?, label?, tone? }`. It counts as a node.
- Strings are clipped to 4000 characters per field rather than rejected, except `language` (80) and table column labels (240); an option `value` longer than 240 characters is rejected. Put long content in `markdown`/`code`, not in many small nodes.
- An unknown field is ignored. An unknown `type`, a non-object child, an invalid table or a broken `options` list rejects the whole render; the previous tree stays.

Table content is plain text only; put a button inside a row by using `list`/`listItem` instead. Treat everything shown from external data as text: `text` and `markdown` are the only safe channels, and the Markdown renderer parses into Polyth's own AST (raw HTML is not passed through) with sanitized link and image URLs.

### Limits

| Bound | Value | Rejected or clipped |
| --- | --- | --- |
| nodes per tree | 200 (trailing nodes included) | rejected |
| nesting depth | 12 (root is 0) | rejected |
| string length | 4000 characters per field | clipped |
| `options` | 64, unique `value` (≤240 characters), non-empty `label` | rejected |
| table | 12 columns × 100 rows, every row the same width | rejected |
| renders | 10 per second per runtime | rejected, previous tree kept |
| id/action | 128 characters, `[A-Za-z0-9._:-]` | silently dropped (id/action omitted) |

There is no raw HTML node, arbitrary CSS, arbitrary script URL, remote-image primitive, or incremental patch protocol; those stay deliberately unsupported until a complete contract exists.

### Example

A search field, a bounded list, an empty state and one action per row, all re-rendered from package state. `listItem` emits no row value, so each row carries its own action id:

```ts
let query = "";
let opened = "";
const items = [{ id: "a", title: "Alpha", note: "First" }, { id: "b", title: "Beta", note: "Second" }];

const tree = (): RemoteUiNode => {
  const visible = items.filter((item) => item.title.toLowerCase().includes(query.toLowerCase()));
  return {
    type: "stack",
    gap: "md",
    children: [
      { type: "input", label: "Search", placeholder: "Filter items", value: query, action: "items.search" },
      ...(opened ? [{ type: "text" as const, tone: "muted" as const, text: `Open: ${opened}` }] : []),
      visible.length === 0
        ? { type: "empty", title: "Nothing matches", body: "Try a shorter search." }
        : {
            type: "list",
            children: visible.map((item) => ({
              type: "listItem",
              id: `item.${item.id}`,
              title: item.title,
              subtitle: item.note,
              action: `items.open.${item.id}`,
              trailing: { type: "badge", text: opened === item.id ? "open" : "idle" },
            })),
          },
    ],
  };
};

polyth.ui.onAction("items.search", (action) => {
  query = typeof action.value === "string" ? action.value : query;
  void polyth.ui.render(tree());
});

for (const item of items) {
  polyth.ui.onAction(`items.open.${item.id}`, () => {
    opened = item.id;
    void polyth.ui.render(tree());
  });
}

void polyth.ui.render(tree());
```

Handlers are keyed by action id, so a list whose rows change must subscribe for the new ids and call the previous unsubscribers (or use one stable `select`/`radioGroup` whose `options` carry the identity and whose action value names the choice). `trailing` is presentation only; it cannot dispatch.

## Tool rendering

Tool rendering has two levels.

### Declarative presentation

A renderer may declare a tool-name matcher plus title/subtitle templates and an output mode (`auto`, `text`, `json`, `markdown`, `code`, or `table`). This path is rendered directly by the host and does not activate the sandbox runtime.

### Dynamic presentation

A renderer marked `dynamic: true` receives a bounded canonical tool event under an invocation lease and may return RemoteUI.

Dynamic renderer failure is isolated. The canonical Polyth tool activity remains visible; a renderer cannot make the underlying conversation unreadable.

## Display metadata and taxonomy

A manifest's `display` block carries an optional longer `summary`, author `tags`, and a `screenshots` gallery. All are presentation metadata: they never grant authority and are parsed without executing extension code.

```json
"display": {
  "name": "Design Lab",
  "description": "Palette tools and contrast checks.",
  "summary": "A longer description shown on the package detail view.",
  "icon": "palette",
  "tags": ["design", "accessibility"],
  "screenshots": [
    { "src": "docs/palette.png", "caption": "Palette extraction", "alt": "Swatches with contrast ratios" }
  ]
}
```

Bounds are enforced by the parser: `summary` ≤ 2000 characters, at most 12 tags (≤ 32 characters each, trimmed, lowercased, de-duplicated, stored verbatim otherwise), and at most 6 screenshots per manifest. A screenshot `src` is a relative path inside the package with a raster extension (`.png`, `.jpg`, `.jpeg`, `.webp`, `.avif`, `.gif`); escaping paths, URLs, duplicates, and SVG are rejected outright rather than silently dropped. The host serves only frames the *installed* version actually published, at `/api/plugins/<id>/screenshots/<version>/<index>/<file>`, immutable-cached with `nosniff` and a `default-src 'none'` policy. A declared frame that is missing, empty, or larger than 8 MB is omitted from the DTO instead of rendering as a broken image. Authors control their own API-origin privacy here: screenshots are shipped with the package and never fetched from a third-party URL.

`display.icon` is a glyph (an emoji or one or two non-alphanumeric characters) or a name. The settings UI renders a name as the shared package mark rather than printing the word.

**Types are derived, never declared.** Labels such as `widget`, `command`, `network`, or `sandboxed` come from the real contribution graph and capability list (`classifyPackage` in `@polyth/package-sdk/classify`), so a package cannot advertise a category it does not implement. `InstalledPluginDto` republishes them as `classifiers` alongside the author `tags`; the Settings UI owns their localized labels.

MCP servers and agent skills are host-level configuration today (`/api/mcp/servers`, harness skill directories), not package contributions. The taxonomy therefore has no `mcp` or `skills` category: a filter that advertised one would promise a package capability the runtime does not deliver.

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

Checking and applying are separate, deployment-owner operations (`assertDeploymentPackageMutator`):

- `POST /api/plugins/:id/check-update` (and `POST /api/plugins/check-updates` for every refetchable package) fetches the recorded source and compares the manifest version — or, for a fork, counts upstream commits not yet integrated. It never publishes or activates; the outcome is persisted as `updateCheck` (`checkedAt`, `available`, `version`/`behind`, `error`).
- `POST /api/plugins/:id/update` stages whatever the source now holds through the steps above. Its outcome, including a failure, is also recorded in `updateCheck`. A source that still declares the active version is "no update" (`available: false`), not a republish: edits to a local `file:` source need a manifest version bump. UI/sandbox bundles are built with the install dir as esbuild's working dir, so rebuilding the same tree from a different staging dir yields the same bytes and integrity.
- `POST /api/plugins/:id/update-settings` sets `autoUpdate` and, for a fork, `forkStrategy`. An uploaded archive (`updatable: false`) cannot opt in.

With `autoUpdate` on, the plugins server entry checks each opted-in package at most every 6 hours (first pass ~2 minutes after enable, then a 15-minute tick) and runs `update` only when the check found something. An operator-local source (`file:` under the trusted plugin directory, or an allowed `path:`/`dir:` dev path) is also looked at every 30 seconds (`LOCAL_SOURCE_TICK_MS`, from the first pass on). Every update, and every check that finds nothing or fails, records `updateCheck.sourceFingerprint`, a hash of the source's manifest files (`polyth-package.json`, `package.json`, `polyth-plugin.json`) read before the check; a check that finds a release keeps the previous stamp, so a manual "Check for updates" never holds that release back. The stamp stays on the host and is stripped from the DTO. `registry.changedLocalSources()` lists the opted-in packages whose current hash differs, and only those are checked, so a version bump — edited in place or swapped in as a fresh directory by a sync job — is applied within about 30 seconds. Edits to other files, a sync that swaps in identical manifests, a restart and a rollback do not trigger a check; a failed check waits for the next manifest change or the 6-hour pass. Both passes share one queue and never run concurrently. Auto-updates use the same candidate path and connection retirement as the route, so new authority still waits for review; the 6-hour pass skips any package with a staged candidate, and the local pass skips one whose candidate awaits review (missing grants or connections) but replaces a candidate that only failed to activate with the next release. A rollback is not a pin: the 6-hour pass re-applies a newer source version once it is due. After a successful update, published versions beyond the active, previous, pending candidate and three most recent others are pruned.

### Fork installs

`POST /api/plugins/install` accepts `{ source, fork: { strategy: "rebase" | "merge" }, autoUpdate }` for a forge repository URL. Polyth clones the repository (gh, then HTTPS, then SSH — the same order as the authenticated checkout) into `<plugins>/<id>/fork`, renames `origin` to `upstream` and works on a local `polyth-local` branch. Commits made in that clone are the operator's customizations. An update fetches the upstream ref, then rebases the local commits onto it or merges it in; a conflict aborts the integration (`rebase --abort`/`merge --abort`), leaves the fork and the active version unchanged and records the error. Uncommitted changes in the fork block an update instead of being discarded. Only committed content is published (`git archive` through the hardened zip extractor), and each fork version carries the commit as semver build metadata (`1.2.0+g<12-hex>`) so local commits without a manifest version bump still get a distinct version. The fork lives on the Polyth host only; nothing is created or pushed on the forge account.

Fork bytes are a public checkout, not an operator-owned local tree, so fork installs keep the remote trust class: sandboxed runtimes only, no `entries.server`.

## Installation sources

Workspace packages follow the same atomicity: one folder, data under its id,
no host references, leftovers listed for the instance owner. The rules are in
`.agents/skills/polyth-packages/package-structure.md` §0 and are enforced by
`scripts/test/packageRemovability.test.ts`.

The currently supported sources are:

- `https://…` (or `zip:https://…`): a ZIP archive fetched over HTTPS. Downloads go through the outbound broker's public-URL pinning and DNS checks, with bounded redirects and byte ceilings.
- A forge repository URL: `github.com/<owner>/<repo>[/tree/<ref>]`, `gitlab.com/<group…>/<repo>` (or `/-/tree/<ref>`), and `codeberg.org/<owner>/<repo>`. The ref defaults to `HEAD`. GitHub supports private repositories through the Polyth host's existing authentication; GitLab and Codeberg use public archive downloads. The Settings installer shows the repository/ref and, for public forge downloads, the resolved archive URL.
- `file:<relative>` against the configured trusted plugin directory, or an explicitly enabled `path:`/`dir:` development path.
- An archive uploaded through the Settings page (base64 in the JSON body, ≤ 16 MB, zip signature verified before extraction).

### Install links

The package catalog (packages.polyth.app, built from the `polyth-site`
repository) opens a person's own Polyth with one of two links. Both only
navigate; neither installs or enables anything by itself:

- `/?settings=packages&package=<id>` opens Settings → Packages, clears its
  filters, and brings that built-in package's row into view with its switch
  focused. An id this Polyth does not have shows a notice instead.
- `/?settings=packages&install=<source>` opens Add package on the link tab,
  with the source prefilled and a note that it came from a link. The person
  presses Install; review of grants and connections follows as usual.

`packagesLinkFromSearch` (`apps/web/src/router.ts`) bounds the values: the id is
a lowercase slug, and the source is at most 2048 characters with no whitespace
or control characters. The installer still decides which sources it accepts.
Boot strips both parameters from the address. The page hands the source to its
`settings.packages.content` contributions as `packagesInstallRequest`, and the
library clears it with `clearPackagesInstallRequest` once its dialog is open.

The installer and managed library are on the `packages` Settings page alongside
built-in package controls. Repository installation and updates first fetch the
public HTTPS archive. Only HTTP 404 permits authenticated acquisition; other
HTTP errors, transport failures and invalid archives are reported directly.
For GitHub, the authenticated path uses `gh api --hostname github.com` with
the host's existing CLI authentication.
If gh is unavailable or not signed in, the GitHub package checks the host's
existing SSH agent/keys with non-interactive, strict host verification, fetches
only the requested ref into a disposable bare repository, then creates a ZIP.
There is no checkout, hook execution, filter execution, or submodule recursion;
Git configuration cannot rewrite the fixed `ssh://git@github.com` destination.
Commands have time/output limits, and SSH staging is capped at 128 MiB for the
32 MiB archive ceiling. An authenticated access denial, network failure, or SSH
host verification failure is reported without retrying the public download or
switching to another acquisition path.
The GitHub provider owns acquisition through its `github` service; plugins
resolve `downloadArchive` lazily for both installation and updates. If that
provider is unavailable or returns no archive, the existing non-interactive
repository checkout fallback remains available after the same public HTTP 404.
Provider-produced ZIPs remain untrusted archive sources; the existing checkout
path retains its checkout validation and trust classification.
Instance-owner authorization continues to guard deployment-wide installation
and updates. Polyth login and a browser's GitHub login do not grant this host
repository access. Tokens/keys stay in their existing CLI/SSH stores and are
never copied into plugin settings or persisted source URLs. HTTP 404 on a
public download can mean a missing repository/ref or a private repository;
the installer retains the source for retry and also accepts an uploaded ZIP.

An uploaded archive installs a sandboxed package; it is never a trusted local source, so `runtime.kind: "trusted-local"` is refused. Re-uploading a newer archive for an installed id stages it through the same candidate-version and permission-review flow as a fetched update (`previousVersion` stays available for rollback). Because an upload cannot be refetched, `update` reports that a new archive must be supplied instead of pretending the source is still reachable.

A general Git source mode is intentionally not exposed. GitHub's bounded SSH-to-ZIP acquisition is provider-owned and rejoins the existing hardened ZIP staging, manifest validation and permission review; it does not enable arbitrary Git URLs, hosts or native runtimes from downloaded sources.

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

## Agent authoring

Every installation's agents can build the person's own packages. The package
manager (`packages/plugins`) registers two deployment-scoped capabilities when
it enables:

- the product skill `polyth-packages` (`src/agentSkill.ts`), self-contained so
  it needs no repository files: when to choose a sandboxed or a trusted server
  package, working templates for both, contributions, capabilities, RemoteUI,
  agent tool/skill registration from a trusted entry, tenancy, disposal, and
  the check → propose_install → Update loop;
- the tool `polyth_packages` (`src/agentTool.ts`), whose actions are
  `info` (the trusted plugin directory `file:` sources resolve against, the
  engine version, edition, UI slots, limits), `list` (installed packages and
  their state in the calling Space, the same view as `GET /api/plugins`),
  `check` (loads the manifest of `<trusted dir>/<id>`, checks engine, assets
  and runtime rules, and builds its UI/sandbox bundle into a temporary
  directory exactly as install does; server code is not executed),
  `propose_install` (runs `check`, then appends a `plugins/install-proposed`
  event to the calling session) and `logs` (the same lines as
  `GET /api/plugins/<id>/logs`).

Neither installs, enables or grants anything. The install block is the
person's seam (`src/installProposal.ts`, `widgets/InstallProposalBlock.tsx`,
slot `session.timeline.event`):

- every field it shows (name, version, required capabilities, connections,
  contribution kinds, whether it runs server code) is read on the server from
  the folder's manifest, never taken from the agent, and the event carries the
  manifest's sha256;
- its one button runs the Settings → Packages sequence under the person's own
  session: `POST /api/plugins/install` with `expectManifestSha256` (the
  registry refuses a staged manifest with another hash, so the agent cannot
  swap the package after the person saw it), then grants of the required
  capabilities and connections it listed, then enable. Install stays
  instance-owner only and enable Space-admin only, by the same route checks;
- `GET /api/plugins/install-access` answers `{ install, enable }` by running
  those same checks. Only a caller who may install sees the "runs code on this
  server" line; anyone else sees who can, and a link to hand the owner;
- the outcome reaches the agent as an ordinary message the person's client
  sends (`host.conversation.send`), so it is in history and wakes the agent.
  It is not a permission request: no Auto-approve level, judge, delegated
  approval or standing rule can press it.

`/?settings=packages&install=file:<id>` remains the fallback. `loadServerEntry` reads the same manifest install did
(`loadCanonicalManifest`: `polyth-package.json` `runtime.server`, a
`package.json` `polyth` object, or legacy `polyth-plugin.json`
`entries.server`) and refuses one whose real file leaves the install
directory. React UI in host slots (`entries.ui` + `contributions`) still needs
`polyth-plugin.json`: a v2 trusted-local manifest maps no slot contributions.
Change the skill text
whenever a manifest field, capability, contribution kind, install source or
limit it names changes; `test/packagesAgentSkill.test.ts` installs the skill's
trusted-package template end to end.

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
