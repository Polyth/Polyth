# Package structure requirements

Load this when creating a package, adding a delivery form (workspace ↔ managed),
changing a package's manifest/version/widget catalog, or reviewing a package
repository. Host facts below are source-inspected against
`packages/plugins/src/{managedManifest,managedRegistry,trustedServerEntry,uiBundle,confineBundle}.ts`;
re-check those files if behavior seems to differ.

## 0. Containment: a package is one removable folder

Every package is **removable** unless it is listed in `FRAMEWORK_PACKAGES`
(`scripts/test/packageRemovability.test.ts`, each with a reason). New packages
are removable by default; making one framework is a reviewed decision, used
only for host seams and services so many features build on them that a
separate folder would be fiction (contracts, session, plugins, models, git,
terminal, …).

A removable package must satisfy all of these. The test enforces 1–3.

1. **Nothing outside its folder names it.** The host (`apps/*`,
   `packages/server`, framework packages, `scripts/`) reaches it only through
   generic seams: discovery (`polyth.serverEntry` / `polyth.webEntry` /
   `./i18n` exports), UI slots and widget areas, web-sdk registrations,
   server services resolved lazily by key (`host.services.get`). A host file
   may not import its modules, CSS or translation catalogs, not even
   type-only, and not by relative `../../packages/<id>/` paths.
2. **Dependents declare it.** Another package that genuinely builds on it
   lists it in `package.json` `dependencies`; removing the dependency then
   visibly removes or breaks only its declared dependents. Prefer a service
   key plus a local structural type over importing a removable package's
   types.
3. **Its data lives under its id.** Deployment-wide files go under
   `packageDataDir(host)` (`<dataDir>/packages/<id>`), Space data under
   `host.spaceStorage(ctx).packageDir(host.pluginId)`. Never write into
   `host.storageDir` directly; files that once lived there are moved with
   `adoptLegacyPackageData(host, [...])` (rename once, never overwrite).
   **Renaming a workspace package** (its folder is its id): list the old ids
   in `package.json` `polyth.formerIds` (≤8, never an id that is installed).
   At boot, before packages register, the server moves each
   `<root>/<former>` data directory (deployment, every Space, every person's
   storage and vault) to `<root>/<id>` when the target is free, and moves
   project include/exclude choices (`composition.packageOverrides`) to the
   new id (`packages/server/src/packageRename.ts`,
   `ProjectRegistry.renamePackageChoices`). It never overwrites or follows a
   link; a former directory beside existing data stays and shows as residue.
   Routes, capability/widget/slot ids, service keys and event types are the
   package's own contracts and do not move with it; rename them only with
   their own compatibility plan. Package workspaces keep their recorded id.
4. **Its tests, strings, styles and docs travel with it**: `packages/<id>/test`,
   `packages/<id>/src/i18n`, scoped CSS in the package. Host tests do not
   import package internals. A catalog has all 12 locales, exports `./i18n`
   and `./i18n/*` from `package.json`, and its `index.ts` exports the type
   `<PascalCaseId>MessageKey` (e.g. `PersonalCoachMessageKey`), which the
   generated shell wiring imports; run `npm run i18n:generate` after adding one.
5. **Removal leaves no garbage.** Delete the folder and rebuild (`npm run
   build:web` regenerates the i18n wiring; server discovery skips the absent
   package; the release gate drops its entries). Leftover data appears under
   *Settings → Packages → Data from removed packages* for the instance owner
   (`GET/DELETE /api/packages/residue`), including what people kept in their
   own storage and vault (`host.people`); it is never deleted automatically.
   Managed packages (`polyth-plugin.json`) are installed and removed through
   the package manager, which deletes their install home and Space data.

Install forms: drop a workspace package folder into `packages/` and rebuild;
upload a managed package archive or give a GitHub/GitLab/Codeberg URL in
Settings → Packages (see `docs/dev/extensions.md` "Installation sources").

`KNOWN_REFERENCES` / `SHARED_ROOT_WRITERS` in the test record remaining,
reasoned debt. They may only shrink; the test fails on stale entries.

## 1. Pick the delivery form first

| Form | Declared by | Server code | Browser code | May import `@polyth/*` at runtime |
| --- | --- | --- | --- | --- |
| Workspace (first-party, in this repo) | `package.json` `polyth.serverEntry` / `polyth.webEntry` / `polyth.descriptor` | `ServerPackage` from `@polyth/plugins`, loaded from source | `defineWebPackage` from `@polyth/web-sdk`, built by the host web build | yes, through declared exports |
| Managed trusted (`trust: privileged \| credentialed`) | `polyth-plugin.json` `entries.server` / `entries.ui`, `contributions`, `widgets` | file imported **as is** by Node; default export is a `Plugin` factory receiving `TrustedServerPluginHost` | `entries.ui` bundled by the host with esbuild, React external, imports confined to the install dir; must export `modules` (and optional `icon`, `surfaces`) | **no** — nothing outside the install dir resolves; type-only imports are fine |
| Sandboxed (`manifestVersion: 2`, `runtime.kind: "sandboxed"`) | `polyth-plugin.json` | none | sandbox entry built by the host | only `@polyth/package-sdk` (see `docs/dev/extensions.md`) |

Consequences that are easy to miss:

- The host reads the installed version **only** from `polyth-plugin.json`
  `version`. `package.json` `version` is not consulted for managed packages;
  update checks compare the manifest version.
- A managed `entries.server` file must be self-contained JavaScript. If the
  source imports `@polyth/*`, `ws` or other dependencies, the repository must
  ship a bundled artifact (for example `dist/server.mjs`), because the host
  does not build server entries.
- Remote (forge/zip/fork) installs cannot activate `entries.server`; it needs a
  trusted local source or an authenticated repository checkout.
- Managed `contributions` carry only `slot`, `id` and `module`. A
  `settings.pages` contribution whose `id` equals the package id is the
  package's own settings page: the host titles it with the manifest `name` and
  addresses it by the package id, so curated nav placement, icon, search
  synonyms and guarded-account hiding keyed by that id apply
  (`apps/web/src/pluginBridge.ts`). Other managed settings pages keep the
  `slot:<id>` page id and a label derived from the id. A managed page never
  takes an id a built-in or workspace page already uses
  (`apps/web/src/components/SettingsView.tsx`).
- A repository that is both a workspace package and a managed package is a
  **dual-form** package. It is allowed, but it must follow §2.

## 2. One source of truth per fact (DRY rules)

Every fact below has exactly one authored location. Other forms derive from it
by import, generation, or a test that fails on drift. Hand-editing the same
fact in two places is a defect even if they currently agree.

| Fact | Canonical location | Derived consumers |
| --- | --- | --- |
| Package id and version | `polyth-plugin.json` for managed/dual-form; `package.json` for workspace-only | `package.json` version (sync check), server `Plugin.manifest.version` (import the manifest JSON or a generated constant — never a literal) |
| Widget catalog (id, title, description, slots, sizes, audience, flags) | one data module, e.g. `src/widgetCatalog.ts`, or the manifest `widgets` array | `polyth-plugin.json` `widgets` (generated or test-compared), server `Plugin.manifest.widgets`, web `WidgetPlugin.widgets` (catalog spread + `render`/`settingsRender`) |
| Module id → component map | one `modules` record | managed `entries.ui` exports it; workspace web entry derives `render` from it |
| Contributions / settings pages (id, label, group, icon, order) | one data module | manifest `contributions`, workspace `host.settings.registerPage` |
| Server wiring (service, routes, watches, agent tools, skill, disposal) | one `createPackageRuntime(host-neutral deps)` returning `{ start, dispose }` | thin workspace `serverEntry.ts` and thin managed `managedEntry.ts` adapters translating their host shape only |
| Display descriptor (name, description, icon, category) | one location, ideally the manifest | `package.json` `polyth.descriptor` (sync check) |

Default enablement and maturity also live in `polyth.descriptor`. Core packages
must be `enabled: true`. Every optional package that ships `enabled: false` is a
preview and must say which kind: `"maturity": "beta"` (works, not well tested)
or `"maturity": "in-progress"` (unfinished, alpha). Discovery rejects a preview
that ships enabled, and `packages/plugins/test/projectCompositionMetadata.test.ts`
fails on an off-by-default package without a maturity. Settings → Packages
badges previews **Beta** / **In progress** and, while one is on, its row warns
that it is not well tested. Remove the field (and enable it by default) once the
package has tests, docs and green gates. `in-progress` packages also stay on
`devel`: a promotion to `master` deletes their folders, so no kept package may
depend on one ([branches](../../../docs/operations/releases.md#branches-devel-and-master)).
Changing a default affects only fresh installs: persisted `packages.json`
choices win.

Adapters may differ only where the host contracts differ (`ServerPackageHost`
vs `TrustedServerPluginHost`, `defineWebPackage` vs `modules`). If an adapter
grows feature logic, move it into the shared core.

## 3. Generated artifacts

- A committed build output (for example `dist/server.mjs`) is generated, never
  edited. It needs one documented command (`npm run build:managed` writing the
  real output path, not `/tmp`) and a CI/test **freshness check** that rebuilds
  and fails when the committed file differs. Syntax checks (`node --check`) and
  smoke imports do not prove freshness.
- Pin the bundler version used for committed output so rebuilds are
  byte-stable.
- Generated manifests follow the same rule: generator command + drift check.

## 4. Release checklist (managed or dual-form)

1. Bump the version in the canonical location only; run the sync/generation
   step.
2. Rebuild committed artifacts with the documented command.
3. Run the package tests plus the drift checks (version, catalog, dist
   freshness) and the managed UI/server bundle containment checks.
4. Confirm the commit contains manifest + derived files + rebuilt artifact
   together; a version bump touching only `package.json` is invisible to hosts.

## 5. Review red flags

- The same version string, widget id list or slot list typed in more than one
  file.
- Two server entries that each register tools/routes/watches.
- Widget descriptions or sizes that differ between manifest, server manifest
  and web catalog.
- A committed bundle with no freshness check, or a build script writing to
  `/tmp` only.
- Managed UI or server code importing `@polyth/*` at runtime.
