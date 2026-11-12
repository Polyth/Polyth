# Integration catalog

A curated, typed list of outside services the agent can be connected to: the
MCP endpoint, how it authenticates, and what was actually verified about it —
plus the Integrations window that shows it.

**Preview.** 212 services, each probed by this repository, with its own brand
tile, a package window that adapts to its pane and connecting through the host's existing MCP
service. Probing on a schedule, importing from an upstream registry and a
generated skill per entry are the next slices.

## Where the entries come from

The list starts from [OpenChamber's catalog](https://github.com/openchamber/openchamber)
(MIT; facts only, the wording here is our own) and adds vendor servers found in
the official [MCP Registry](https://registry.modelcontextprotocol.io), whose
reverse-DNS names (`com.stripe/mcp`) are verified against the vendor's domain,
and in vendor documentation. No entry is taken on trust from either: every
remote endpoint was probed from here (`scripts/probe-endpoint.mjs`), and a probe
on a nonsense path of the same host separated real endpoints from hosts that
answer every path alike. Candidates that failed, and why, are in
[Not suitable yet](#not-suitable-yet).

## Why a catalog and not more code

The install plumbing already exists and is owned by the host: `mcp.json` +
Space secrets, project overrides, person-owned servers, the probe and the MCP
page. A catalog is data plus a window over those seams, which is what makes
breadth cheap: one folder per service, one screen that reads them.

## Files

| File | Holds |
| --- | --- |
| `catalog/<id>/integration.json` | One entry. The folder name is the entry id. |
| `src/manifest.ts` | The contract and every validation rule (pure, browser-safe). |
| `src/catalog.ts` | Order, sections, search, counts and the wording helpers (pure). |
| `src/entries.ts` | Reads and validates `catalog/` (server-only, `node:fs`). |
| `src/install.ts` | Manifest → MCP install input, scope rules, pinning gate (pure). |
| `src/installLedger.ts` | Which installations this catalog owns (server-only). |
| `src/serverEntry.ts` | `GET …/entries[/<id>]`, `GET …/logo/<id>`, `POST …/install`, `POST …/uninstall`. |
| `src/strings.ts` | English canonical, Ukrainian overrides. |
| `src/brand.ts` | The brand-mark type and lookup. |
| `src/brandMarks.ts` | Generated: entry id → tile file. |
| `assets/logos/` | The vendored tiles, `sources.json` (where each comes from) and `CREDITS.md`. |
| `scripts/probe-endpoint.mjs` | Probe remote endpoints without credentials and print the evidence. |
| `scripts/build-marks.py` | Build the tiles and `src/brandMarks.ts` from `sources.json` (Pillow). |
| `widgets/` | The workspace surface (`surfaces.register`), its capability and palette command. |

## The window

The catalog is a tool, so it is a workspace surface (`surfaces.register`, id
`integration-catalog`), opened with `openWorkspacePane`. The host `ModuleView`
owns the title, description, Back/Close, safe areas, the phone layer, resize
and fullscreen; the package owns only the content (`contentMode: "workspace"`,
edge to edge with its own `--space-3` gutter). `widgets/IntegrationsView.tsx`
owns the state; `widgets/styles.css` owns the geometry, on the host's tokens
only, and composes the host `TextInput`, `Tabs`, `Button` and `EmptyState`.

- **Narrow pane (under 720px of pane width).** One view at a time: the
  directory, or one service with a quiet "All integrations" button back.
  The search and the category filter (the host `Tabs` strip, which scrolls
  sideways and fades the edge that hides tabs) stay above the list while it
  scrolls. Going back restores the directory's scroll position and focus.
- **720px of pane width** (`@container icat`). The directory (280–360px) and the
  chosen service sit side by side and scroll separately; the selected row
  gets the calm `--surface-overlay-strong` wash. The width is the pane's, not
  the viewport's: a docked window on a wide screen is as narrow as a phone.
- The directory lists each service once: what is connected, then the featured
  ones, then everything under its primary category. A "Connected" tab appears
  as soon as anything is.
- Rows are about 52px with hairline separators: the brand tile (32px), the name
  with Beta/Local tags, one ellipsised line of summary and a "Connected" word.
  Hover lives behind `(hover: hover)`; touch gets `:active` only, so no row
  keeps a tint after a tap.
- The service reads as a document, not a form: heading, the connection facts,
  the action (host `Button`, `busy` while it runs), then About, What it
  installs and What was observed under hairlines.
- Escape steps back one level (confirmation → service → search) and stops
  there; otherwise the window closes. `/` focuses search; arrows walk the list.

### States

| State | What the window does |
| --- | --- |
| Loading | Still placeholder rows (no shimmer). |
| Load failed | Host `EmptyState` with the reason and Try again; offline says so and reloads by itself when the network returns. |
| Broken manifests | A collapsed note with every reason, above the healthy entries. |
| Connections unreadable | The route reports `connections: "unavailable"`; a notice says connected services may look unconnected. |
| No search result | The query and Clear search; inside a category, Search all categories. |
| Needs inputs | A site picker (native select) or a checked text field; the endpoint preview fills in as you type. |
| Needs a key | Connect waits for the key and says why; an optional key says Optional. |
| Connecting / disconnecting | The button's own busy spinner; the rest of the window stays usable. |
| Connected | A "Connected" tag, the word in the row, the Connected section and tab. |
| Connected, switched off | "Connected, turned off", the reason, and a way to MCP settings. |
| Connected by hand | No Disconnect (the catalog never removes what it did not add); a way to MCP settings. |
| Disconnecting a personal key | One in-place confirmation, because the stored key is deleted. |
| Already connected elsewhere | A 409 from a second tab refreshes to the connected state instead of an error. |
| No project open | "The whole Space — no project is open", and the install is recorded that way. |
| Install refused | The server's own message (an unpinned command, a local server on a sandboxed host, a bad input). |

`openWorkspacePane("integration-catalog", "<entry id>")` opens one service
directly: the host hands the content `resource` and `resourceSeq`. On a phone
the window's own Back returns from a service to the directory
(`host.ui.useWindowBack`), so the content draws no second back control there.

## Ways in

The catalog is a place people reach for a reason, so it has more than a
rail tile. Every owner below keeps the link as a plain surface id; none
imports this package, and a disabled catalog removes the link with the window.

| Where | Moment | Mechanism |
| --- | --- | --- |
| Settings → MCP | "I need a server" | `harness-runtime` asks `host.surfaces.has("integration-catalog")` and opens the window with `openWorkspacePane`. A host without `surfaces.has` gets no button. |
| Command palette | a verb, not a window name | `integrations.connect`, keyworded by service and in both languages. |
| Capability and rail | browsing | capability `integrations`, right rail for `general`/`engineering`. |

## The manifest

`id` must equal the folder name; `schemaVersion` is 1. Field names follow the
official MCP Registry `server.json` where they overlap, so an importer can
normalize into this shape later.

- `mcp.auth`: `oauth` | `token` | `none`. An `oauth` entry ships only when its
  probe recorded `registration: "dynamic"` (a test enforces it): the harnesses
  sign in in one click only where the authorization server lets them register
  themselves.
- Exactly one of `mcp.remote` (an `https` URL) and `mcp.local` (argv,
  prerequisites, a startup timeout for a first-run download).
- `mcp.auth: "token"` requires `mcp.tokenHelpUrl` — a person must know where
  the key comes from. `tokenOptional: true` means it works without one.
- `categories`: one or two from `CATEGORY_ORDER` (the window's filter order); the
  first is the primary one the directory files it under.
- `mcp.inputs`: values the endpoint interpolates where it says `{id}` — a
  Datadog site, an Azure DevOps organization. Each is bounded by `choices` or an
  anchored `pattern`, every value must also match a plain-token rule (no
  separators, no URL or shell syntax), and an input that lands in a URL's host
  must be a choice: a typed value never decides which server receives the
  sign-in or the key. The validator checks every token is declared and every
  declared input is used, and the planner re-checks the values server-side.
- `evidence` is required and says how sure the entry is:
  - `state: "observed"` — this repository answered a request and records the
    `httpStatus` and the `challenge` it saw.
  - `state: "documented"` — read in vendor docs only (used for local packages,
    which this slice does not install or start).
  - `state: "pending"` — not checked yet; an entry should not ship this way
    for long.
  `checkedAt` is an ISO date, `source` is where the claim comes from.

A bad manifest is not silently skipped: the loader reports every reason, the
route returns them next to the healthy entries, and the window lists them in a
collapsed note above the directory. A broken entry must never look like an absent one.

## Adding an entry

1. Create `catalog/<id>/integration.json` (copy a neighbour of the same auth
   kind) and make the summary one line about what the agent can do.
2. Observe the endpoint before claiming anything:

   ```sh
   node packages/integration-catalog/scripts/probe-endpoint.mjs https://mcp.example.com/mcp
   ```

   It sends one unauthenticated `initialize`, follows the OAuth discovery chain
   on a 401 and prints the verdict as JSON: `oauth` (dynamic registration —
   ship as `auth: "oauth"`), `open` (`none`, or `token` + `tokenOptional` when
   the vendor documents a key), `token` (a key in a documented header),
   `registered-app` or `oauth-cimd` (not one-click: use a documented token or
   leave it out), `refused`/`unreachable` (leave it out). Probe a nonsense path
   on the same host too; if it answers the same way, confirm the path in the
   vendor's docs. Record the result in `evidence`.

   The probe never registers a client: dynamic client registration leaves a
   real client at the vendor. `--catalog [id…]` re-probes shipped entries.
3. Run the checks below. Then the window shows it.

## Connecting

The package writes nothing itself. `src/install.ts` turns an entry into the
input the host's `mcp.project` service already accepts, and the host stores the
secret and writes the native configuration:

| Entry | Scope | Where the secret lives |
| --- | --- | --- |
| `auth: "oauth"` | the project | none — the first tool call starts the service's sign-in |
| `auth: "none"` | the project (or the Space) | none |
| `auth: "token"` | the person only | their Credential Vault partition, write-only |
| local server | the project | none, and the command must be pinned |

Three rules are not negotiable here:

1. **A token entry is person-owned.** Only the person-scoped store is
   write-only by contract; a Space install keeps secrets in the Space's MCP
   secret file, which is right for a service account and wrong for a personal
   API key. Asking for a Space copy of a personal key is refused, not silently
   downgraded. The consequence is honest: the server reaches that person's own
   chats, not a shared one.
2. **A token entry must declare `mcp.remote.tokenHeader`.** The catalog never
   guesses where a key travels. An entry without it reports
   `token-header-missing` and stays uninstallable until its manifest says.
3. **A local package must be pinned to an exact version.** `@latest`, a range
   or a bare name is refused by the manifest validator during the test run and
   again by the install planner, because the reviewed bytes must be the
   installed bytes. A Docker image needs a tag other than `latest` or a digest.

Installing is `POST /api/integration-catalog/install` with
`{ entryId, projectId?, token?, scope?, inputs? }`; a second install of a
connected entry answers 409 `already-installed` with the existing row, and an
install without a project is recorded for the whole Space. Removing is
`POST /api/integration-catalog/uninstall` with `{ entryId }`.

Removal only touches installations this catalog made. The ledger
(`<Space package dir>/installs.json`) records the entry, the MCP server id and
its scope; a server a person created by hand with the same name is reported as
`catalogManaged: false` and is left alone.

## Brand marks

Each entry shows the service's own mark, served from `assets/logos/` by
`GET /api/integration-catalog/logo/<id>`. The marks are vendored, not fetched
from a vendor CDN when the window renders: a list of favicon requests would tell
two hundred third parties which integrations somebody is browsing, and it would
break on an offline or restricted network.

Every file is a finished square tile, so it reads the same in a light and a
dark theme and the window only rounds it and draws a hairline: 104 are
simple-icons glyphs (CC0) on their brand colour — white on a strong colour, the
colour itself on a dark tile when it cannot hold white — and the rest are the
vendor's own app icon (touch icon, manifest icon, the icon its MCP server
declares, or its GitHub organization avatar), 128px palette PNGs or plain SVG.
Row tiles load lazily, so the directory requests only what is on screen.
`assets/logos/CREDITS.md` has the provenance; the tests fail when an entry has
no tile, a tile is not square and sharp, an SVG carries script or external
references, or a tile has no reviewed source.

## Not suitable yet

Probed on 2026-11-11 and left out, so they are not retried blind:

| Service | Reason |
| --- | --- |
| Asana, Slack, HubSpot, Box, PagerDuty, Docusign, Smartsheet, Xero, Dovetail, Pitch, YouTrack | The authorization server has no dynamic registration: it needs an app registered by hand. A field for the person's own OAuth client would open these. |
| Zendesk, Steel, ngrok | Client ID metadata documents only, which the harnesses do not all support yet. |
| AWS MCP Server | `initialize` is open, but tool calls are signed with SigV4, which needs AWS's local proxy. AWS Knowledge (docs) ships instead. |
| Gamma | Refuses a loopback redirect, which local harnesses need (OpenChamber's probe). |
| Stack Overflow, Pipedrive, Rippling, QuickBooks, Bitbucket, Twilio, Kagi | 401/403 without OAuth metadata and no documented header, or a host that answers every path the same way. |
| RunPod, Instatus, Plaid | The host answers every path the same way and the path could not be confirmed in vendor docs. |
| Grafana (local), MCP Toolbox | Need connection settings in environment variables, which the catalog cannot ask for yet. |
| MarkItDown | Only alpha releases, which the exact-version pin rule cannot accept as stable. |
| Datadog Gov | `ddog-gov.com` did not answer at the documented path. |

## What is deliberately not here

- **A key for local servers.** Local servers that need a token in their
  environment (Brave, Elastic, CircleCI) are left out until the install planner
  can put a Vault reference into a stdio environment.
- **Continuous verification.** A scheduled probe that turns a broken or
  auth-drifted entry into a visible status instead of a stale comment.
- **Upstream import.** A normalizer from the official MCP Registry into this
  manifest shape plus a review queue.
- **A generated skill per entry**, so the agent knows the tools' semantics
  instead of only their names.
- **Twelve locales.** The window is English with Ukrainian overrides in
  `strings.ts` (the Glance pattern). The full locale catalog is a promotion
  cost, not a preview cost.

## Checks

```sh
node scripts/run-tests.mjs packages/integration-catalog/test/*.test.ts
npx tsc --noEmit -p packages/integration-catalog
node scripts/test/packageRemovability.test.ts
node --experimental-strip-types apps/web/buildPackages.ts
```

The last two prove the package stays one removable folder and that its window
builds as a package bundle.
