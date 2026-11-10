# Integration catalog

A curated, typed list of outside services the agent can be connected to: the
MCP endpoint, how it authenticates, and what was actually verified about it —
plus the page that shows the list in place of Chat.

**Preview.** The catalog, its page and connecting through the host's existing
MCP service ship here. Probing on a schedule, importing from an upstream
registry and a generated skill per entry are the next slices.

## Why a catalog and not more code

The install plumbing already exists and is owned by the host: `mcp.json` +
Space secrets, project overrides, person-owned servers, the probe and the MCP
page. A catalog is data plus a page over those seams, which is what makes
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
| `src/brand.ts` | Entry id → the service's own brand mark and colour. |
| `assets/logos/` | The vendored marks themselves; provenance and licences in `CREDITS.md`. |
| `scripts/` | Developer commands: refresh the vector marks, derive a raster mark. |
| `widgets/` | The page (`pages.register`) and the capability that opens it. |

## The page

A directory beside a document, not a table. `widgets/IntegrationsPage.tsx` owns
the state; `widgets/styles.css` owns the geometry, on the host's tokens only.

- The directory is a 340px column on the page (no second panel: three nested
surfaces at 1.07:1 read as a form), with rows that carry the service's own mark,
its name, up to two lines of what it gives the agent, and a dot when connected.
Its search field and category chips live *inside* that column, so they filter
what they sit on and leave with it on a phone (`display: none`, not a
hidden-but-tabbable row).
- The entry is a document: mark, name, one-line promise, publisher, then the
connection card — the one filled box, holding the facts the action depends on
(sign-in, where it installs), the API-key field when one is needed, and the
action in one place for every entry (the card's bottom-inline-end; full width
on a phone). Evidence sits behind a "How it was checked" disclosure.
- Everything separates with a fill or an `inset` contour shadow. Borderless
appearance is on by default and clears every border colour, so a card edge or a
selected row drawn as `border` disappears for most people.
- Fixed geometry, never `--density-scale`: density describes the chat's rhythm
and scaling these sizes produced 24px controls and 22px marks. One row pitch
(72px, 76 on a phone) for every row: a two-line promise used to make its own row
11px taller, which broke the column's rhythm.
- One vertical ladder — 4 (title to subtitle), 8 (label to its content), 12
(specimen gap), 16 (head to controls), 24 (document blocks) — and both columns
start on the same line: the detail head's mark sits level with the search field.
- Text direction is per block (`unicode-bidi: plaintext`), because the shell can
be RTL while these strings are English or Ukrainian; without it a sentence-final
period lands on the wrong side.
- Below 900px of page width one screen replaces the pair; at 640px the facts
stack, the card stacks and the action is full width at `max(--control-h-lg,
--hit-min)` — a compact shell look publishes 36px, which must not beat the
44px coarse-pointer floor.

## Ways in

The catalog is a place people reach for a reason, so it has more than a
navigator row. Every owner below keeps the link as a plain page id; none
imports this package, and a disabled catalog removes the link with the page.

| Where | Moment | Mechanism |
| --- | --- | --- |
| Settings → MCP | "I need a server" | `harness-runtime` asks `host.pages.has("integration-catalog")` and opens the page. |
| Command palette | a verb, not a page name | `integrations.connect`, keyworded by service and in both languages. |
| Capability and rail | browsing | capability `integrations`, right rail for `general`/`engineering`. |

## The manifest

`id` must equal the folder name; `schemaVersion` is 1. Field names follow the
official MCP Registry `server.json` where they overlap, so an importer can
normalize into this shape later.

- `mcp.auth`: `oauth` | `token` | `none`.
- Exactly one of `mcp.remote` (an `https` URL) and `mcp.local` (argv,
  prerequisites, a startup timeout for a first-run download).
- `mcp.auth: "token"` requires `mcp.tokenHelpUrl` — a person must know where
  the key comes from. `tokenOptional: true` means it works without one.
- `categories`: one or two from `CATEGORY_ORDER` (the page's filter order).
- `evidence` is required and says how sure the entry is:
  - `state: "observed"` — this repository answered a request and records the
    `httpStatus` and the `challenge` it saw.
  - `state: "documented"` — read in vendor docs only (used for local packages,
    which this slice does not install or start).
  - `state: "pending"` — not checked yet; an entry should not ship this way
    for long.
  `checkedAt` is an ISO date, `source` is where the claim comes from.

A bad manifest is not silently skipped: the loader reports every reason, the
route returns them next to the healthy entries, and the page shows them in a
warning strip. A broken entry must never look like an absent one.

## Adding an entry

1. Create `catalog/<id>/integration.json` (copy a neighbour of the same auth
   kind) and make the summary one line about what the agent can do.
2. Observe the endpoint before claiming anything:

   ```sh
   curl -s -o /dev/null -D - -H 'accept: application/json, text/event-stream' https://mcp.example.com/mcp
   ```

   `401` + `WWW-Authenticate` with `resource_metadata` is the OAuth shape;
   `401` + "missing API key" is the token shape; `405` with a JSON-RPC body
   means the endpoint is alive but refuses `GET`; no `WWW-Authenticate` at all
   means nothing was demanded up front. Record exactly that in `evidence`.

   Do not register an OAuth client just to check an entry: dynamic client
   registration leaves a real client at the vendor.
3. Run the checks below. Then the page shows it.

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
`{ entryId, projectId?, token?, scope? }`; removing is
`POST /api/integration-catalog/uninstall` with `{ entryId }`.

Removal only touches installations this catalog made. The ledger
(`<Space package dir>/installs.json`) records the entry, the MCP server id and
its scope; a server a person created by hand with the same name is reported as
`catalogManaged: false` and is left alone.

## Brand marks

Each entry shows the service's own glyph, served from `assets/logos/` by
`GET /api/integration-catalog/logo/<id>`. The marks are vendored, not fetched
from a vendor CDN when the page renders: a page of favicon requests would tell
a dozen third parties which integrations somebody is browsing, and it would
break on an offline or restricted network. `src/brand.ts` is the registry, and
a test fails when an entry has no mark or the file is missing.

Vector marks are drawn as a CSS mask, so the glyph takes the theme's text
colour — a brand colour alone cannot stay readable in both themes (GitHub and
Notion are near-black). The tile keeps the brand hue, mixed onto a surface
token so a dark brand does not vanish into the page.

## What is deliberately not here

- **Continuous verification.** A scheduled probe that turns a broken or
  auth-drifted entry into a visible status instead of a stale comment.
- **Upstream import.** A normalizer from the official MCP Registry into this
  manifest shape plus a review queue.
- **A generated skill per entry**, so the agent knows the tools' semantics
  instead of only their names.
- **Twelve locales.** The page is English with Ukrainian overrides in
  `strings.ts` (the Glance pattern). The full locale catalog is a promotion
  cost, not a preview cost.

## Checks

```sh
node scripts/run-tests.mjs packages/integration-catalog/test/*.test.ts  # 58
npx tsc --noEmit -p packages/integration-catalog
node scripts/test/packageRemovability.test.ts
node --experimental-strip-types apps/web/buildPackages.ts
```

The last two prove the package stays one removable folder and that its page
builds as a package bundle.
