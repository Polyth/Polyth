# Dependency-free agent-kit CLI

Run `node scripts/agent-kit.mjs help` from any directory inside a checkout. The CLI discovers its own repository root from its file location; it does not trust the current directory for file access. Node >=22.14 is required. The optional installer requires Python >=3.10 and has separate fixture tests. Git is required for inventory and impact, but not for map/context/structure validation.

| Command | Output | Reads |
| --- | --- | --- |
| `map` | All area names, risk and short purpose | Task map only |
| `context <area>` | Selected skill, entry points, references, test hints and source status | Small registry + area evidence anchors |
| `context --path <path>` | Relevant areas, including conservative cross-cutting matches | Small registry; no source-body scan |
| `doctor [area]` | Unchanged/changed/missing evidence anchors with coverage labels | Hashes only recorded source files |
| `doctor [area] --strict` | Same, nonzero when any inspected anchor changed/missing | Hash equality is not semantic proof |
| `inventory [--package <name-or-path>]` | Current workspace manifests, declared exports/entries/dependencies, test paths and reverse declared dependency graph | One-level workspace manifests and Git path metadata |
| `impact --base <ref>` | Base-to-worktree changes including staged/unstaged/untracked paths, routes, affected owners and reverse declared consumers | Read-only Git diff/path metadata and manifests |
| `check` | Structural/links/route checks in a complete checkout | Kit files and mapped path existence; not TypeScript analysis |
| `check --kit-only` | Standalone-overlay structural checks | No application files required; must not be mistaken for full-checkout validation |
| `bundle <area>` | Bounded Markdown context on stdout | Allowlisted kit documents only; no arbitrary source bodies |

`--json` is supported by non-bundle commands. Unknown flags/areas fail rather than selecting a guessed default. Commands never install dependencies, access network, execute manifest scripts, mutate git or call a running Polyth instance. They write only stdout/stderr. Redirect output explicitly when a saved packet is needed. Do not use generated inventory as a committed truth without a review reason.

## Safety and scope

Repository-relative paths reject traversal, absolute paths, backslashes, NULs and symlink traversal. Reads and Git output are bounded. Git receives argument arrays without a shell, with inherited Git redirection variables removed and filesystem-monitor/hooks disabled; `impact` resolves a revision to a commit before diffing. The tool does not execute files mentioned in metadata. It does not evaluate JavaScript or infer complete imports from manifests.

The task map is curated. Reverse dependencies are **declared manifest dependencies only**, so dynamic registry/service links, undeclared imports, external consumers and generated/native bindings may be missing. `impact` is a conservative starting point, never a certificate that unaffected packages cannot regress. Lockfile/toolchain/public-contract/native changes need broader checks than this map alone can prove.

`doctor` compares raw Git blob hashes and an LF-normalized alternative for text checkouts. It prints the historical review coverage. No automatic baseline refresh exists by design. For unmapped code, report missing coverage and inspect the owner rather than claiming freshness.

## Tests

```sh
node --experimental-strip-types --test scripts/test/agent-kit.test.ts
```

Tests use temporary isolated fixture repositories, built-in `node:test`, assertions and Git; no application dependencies or live services. They cover path/symlink safety, metadata/route validation, drift semantics, inventory limitations, diff/untracked/rename/deletion behavior, malformed input and bundle bounds. See the shipped verification report for the actual run, not an assumed pass.
