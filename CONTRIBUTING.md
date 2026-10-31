# Contributing to Polyth

Thanks for your interest in Polyth. This guide covers the local setup, the
conventions the codebase relies on and how to propose a change. Security
problems go through [SECURITY.md](SECURITY.md), not public issues.

## Set up a checkout

Requirements: Node >= 22.16 and npm. At least one coding-agent CLI on your
`PATH` (Claude Code, Codex, OpenCode, Pi, Antigravity or Cursor) to run real
sessions. A Rust toolchain (see `rust-toolchain.toml`) is only needed for
Polyth Link and the desktop app; Chromium is optional (agent browser).

```bash
npm install
npm run build          # bundles apps/web and every package web entry
npm run setup:claim    # first run only, with the server stopped
npm start              # http://127.0.0.1:4400
```

For day-to-day work use `npm run watch`: it rebuilds bundles and restarts the
server when sources change. `npm run agent:beta` starts a disposable loopback
instance with temporary data and no login, which is the safest way to try a
change without touching your own data.

## Where things live

| Path | What it holds |
| --- | --- |
| `apps/web` | The web shell: layout, shared UI primitives, tokens and themes |
| `apps/desktop`, `apps/mobile` | Electron desktop app; Capacitor Android/iOS client |
| `packages/*` | Feature packages and core services. A package owns its server entry, routes, UI and CSS |
| `packages/contracts`, `packages/web-sdk`, `packages/plugins` | The shared contracts and extension seams packages build on |
| `crates/*` | Polyth Link (pairing and remote access) in Rust |
| `docs/` | Architecture, development guides, operations and mobile docs |
| `examples/` | Minimal extension packages |

Start with [docs/dev/architecture.md](docs/dev/architecture.md) for the system
as built and [docs/dev/README.md](docs/dev/README.md) for building a feature
from zero.

## Conventions

- **Package per feature.** New features ship as a package with
  `polyth.serverEntry` / `polyth.webEntry` and register through
  `@polyth/plugins` and `@polyth/web-sdk`. Do not hand-wire features into the
  host shell. A package outside the core set must stay removable as one folder
  ([rules](.agents/skills/polyth-packages/package-structure.md)).
- **Erasable TypeScript.** Node runs the sources with type stripping: no
  `enum`, `namespace` or constructor parameter properties. Local imports keep
  their `.ts` / `.tsx` extension.
- **Browser and Node stay apart.** Browser code must not import Node-only
  package roots; use the browser-safe subpaths each package exports.
- **Canonical history.** Polyth owns sessions, events and runtimes; provider
  threads are subordinate. Persist model-visible facts through the existing
  event path before they reach the UI.
- **Security defaults.** Tenant data lives in Space-scoped storage, paired
  devices are default-deny, and secrets never enter config responses, logs or
  prompts.
- **Few dependencies.** Prefer built-ins and small owned code. A new
  dependency needs a reason in the change description.
- **UI work** follows [the style guide](docs/dev/styles.md),
  [design system](docs/dev/design-system.md) and [UI contracts](docs/dev/ui.md):
  packages own content and scoped CSS, the host owns tokens and layout.

## Tests and checks

The suite uses `node:test`. Run the tests of the packages you touch:

```bash
node --experimental-strip-types --test packages/<package>/test/*.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/<package>/tsconfig.json
npm test               # the whole suite; slow and partly environment-dependent
```

There is no root typecheck or lint script; type-check each project you
change. [docs/agents/verification.md](docs/agents/verification.md) lists the
checks that fit each kind of change, and [docs/agents/commands.md](docs/agents/commands.md)
what every repository command does.

## Working with coding agents

Polyth is built to be changed by agents as well as people. Agents start at
[AGENTS.md](AGENTS.md), then the [task router](docs/agents/README.md); do not
feed a model the whole documentation tree. The repository keeps one canonical
rules file, on-demand domain skills under `.agents/skills/`, small client
adapters (`CLAUDE.md`, `GEMINI.md`, `.cursor/`, `.opencode/`,
`.github/copilot-instructions.md`) and a dependency-free navigation tool:

```bash
node scripts/agent-kit.mjs map               # areas and their skills
node scripts/agent-kit.mjs context mobile    # what to read for one area
node scripts/agent-kit.mjs doctor mobile     # did the recorded sources change?
node scripts/agent-kit.mjs impact --base HEAD
```

The kit tells an agent where to look; it does not replace tests.

## Branches

- **`devel`** is where every change lands, including unfinished packages.
  Nightly builds come from it.
- **`master`** is the release line. It receives only promotions from `devel`,
  which leave out packages marked `"maturity": "in-progress"`; stable and test
  releases are built from it.

Open pull requests against `devel`. A package reaches `master` once its
manifest no longer declares `"maturity": "in-progress"` (see
[releases](docs/operations/releases.md#branches-devel-and-master) and the
[package rules](.agents/skills/polyth-packages/package-structure.md)).

## Proposing a change

1. Open an issue first for anything larger than a fix, so the approach can be
   agreed before you invest in it.
2. Keep pull requests focused and target `devel`. Describe the behavior
   change, the checks you ran and their results, and anything you could not
   verify.
3. Update the owning documentation in the same change when behavior,
   configuration or a public contract moves.
4. Temporary notes, plans and reports belong in the pull request, not in the
   repository; local scratch files go under `.scratch/` (ignored).

## Sign your commits

Polyth uses the [Developer Certificate of Origin](https://developercertificate.org)
(DCO) instead of a contributor license agreement. By adding a sign-off to a
commit you certify that you wrote the change, or otherwise have the right to
submit it, under the project's license. Sign off with the same name and email
as the commit author:

```bash
git commit -s -m "Fix the session list scroll"
# adds: Signed-off-by: Your Name <you@example.com>
```

To sign off commits you already made on a branch, run
`git rebase --signoff devel` and force-push the branch. The DCO check on each
pull request lists any commit that is missing its author's sign-off.

Contributions are licensed under the [Apache License 2.0](LICENSE), the same
license as the project (inbound = outbound); the sign-off records that you
agree to this.
