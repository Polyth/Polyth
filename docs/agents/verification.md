# Verification by risk and evidence

Reduce redundant work, not relevant evidence. Choose the highest applicable risk. A focused test loop comes first; broader checks follow the actual blast radius. No number of documentation checks proves application correctness.

| Change | Minimum useful evidence | Expand when |
| --- | --- | --- |
| Rules/docs/navigation only | Kit check, kit tests, changed links/routes, review wording against cited source | Claims/API references changed: inspect those sources; tools changed: fault/security tests |
| Local pure behavior | Causal unit test and adjacent owner tests | Exports or callers change: consumer typechecks |
| UI/CSS/widget | Relevant unit/interaction/containment checks, affected build and a before/after screenshot shown to the user ([screenshot confirmation](#screenshot-confirmation-for-visual-changes)) | Shared primitives/tokens: representative desktop/mobile/theme/preferences states |
| Package entry/export/lifecycle | Discovery, containment, enable-disable and browser build | Public seam changed: all affected consumers, desktop inventory |
| Session/runtime/queue | Reconciliation, uncertain outcomes, replay/restart/race tests | Broad shared behavior: relevant complete suites and root suite as feasible |
| Space/auth/remote policy | Known-valid cross-Space negative cases, ingress/HTTP/WS and revocation tests | Shared security boundary: full relevant security suites and review |
| Storage/migration | Old fixture upgrade, interruption/reopen, idempotence, isolation and recovery | Large/live data: measured performance and explicit operational approval |
| Mobile/native | Shared web tests, relevant native compile plus platform behavior tests | Native plugin/background/permissions: actual affected OS/device scenario |
| CI/release | Syntax/selector/trigger/permissions checks and appropriate build validation | Publication/signing: explicit approval and actual hosted/release evidence |

## Screenshot confirmation for visual changes

Every change a person can see (layout, spacing, alignment, type, colour, icons, motion end states, responsive or RTL behavior) is confirmed with a screenshot before it is reported done, and the screenshot is shown to the user with the result. A passing geometry test or a source review does not replace it.

- Capture the affected surface from real CSS in a browser (headless Chromium through `playwright-core` and `apps/web/test/chromium.ts`, or the running app/embedded browser) at the relevant viewport, density, theme and direction: phone (about 390–430px wide, `deviceScaleFactor: 2`) for mobile work, desktop width for desktop work.
- For a fix or redesign, show **before and after** side by side, rendered from the parent commit and from the change, so the difference can be judged directly. Look at the image yourself and fix what it shows before reporting.
- Name what the screenshot covers and what it does not (synthetic fixture vs live app, browser vs native device). A browser screenshot is not device verification.
- Screenshots and capture scripts live under `/.scratch/<task-slug>/` and are never committed; durable expectations go into a geometry/interaction test instead.
- Show them in the reply with a ```` ```ui ```` `media` block whose image paths are **relative to the session's working checkout** (`.scratch/<task-slug>/after.png`). Chat refuses absolute paths and `..`, and a path into a different worktree does not resolve. The files must outlive the turn: the scratch cleanup before completion skips screenshots the reply links to.
- Name before/after captures `before*.png` / `after*.png` (`before-phone.png` ↔ `after-phone.png`, `menu-before.png` ↔ `menu-after.png`): the pull request section pairs them side by side.

## Screenshots in pull requests

A pull request that changes what a person can see carries the screenshots that confirmed it. This holds for every agent and harness, for a pull request opened by hand or automatically, and for an isolated branch on its way into its parent.

- **Opening a pull request:** open it (`gh pr create …`), then run `node scripts/pr-screenshots.mjs` in the same checkout. It takes the images under `.scratch/` (or `--dir .scratch/<task-slug>`, or the files named), commits them to the orphan `pr-assets` branch of the pull request's remote through a private index — the working tree, index and current branch stay untouched, and the branch is never merged — and writes a *Screenshots* section into the pull request body, before/after pairs side by side. A rerun replaces the section. `--dry-run` lists what would be published; `--print` publishes and prints the section for a body you write yourself; `--pr <n>` targets another pull request.
- **Delegated isolated children:** a child's `.scratch/` is gitignored, so `agent.merge` does not carry it and the child's workspace is removed afterwards. Before merging a child that changed visible UI, the parent looks at the child's screenshots and runs `node scripts/pr-screenshots.mjs adopt <child-worktree>`, which copies them into `.scratch/from-<child>/` of the parent's checkout; the parent's pull request then attaches them with the parent's own. The child reports its screenshot paths in its final result.
- **Privacy:** the repository is public and `pr-assets` history is permanent. Publish only captures of synthetic fixture or isolated test data. A screenshot of a live instance that shows people, chats, projects, host names or home paths is not published; recapture it from a fixture (see the screenshot rigs) or leave it out and ask. The script lists every file before pushing; look at each one.
- **No visible change:** when a pull request touches UI files without changing what anyone sees (a rename, a test-only refactor), say so in its body with a line `No visible change: <reason>`.
- **Enforced:** `.github/workflows/pr-screenshots.yml` (`scripts/ci/check-pr-screenshots.mjs`) fails a pull request that changes web CSS, TSX, HTML or SVG under `apps/` or `packages/` outside tests while its body has neither an image nor that line. Editing the body reruns it; promotions from `devel` to `master` are not checked.

## Bounded local verification

On a shared Linux host with a systemd user manager, run potentially expensive checks through `node scripts/run-bounded-check.mjs -- node --experimental-strip-types --test --test-concurrency=1 <test-file>`. The wrapper bounds the entire process tree to 768 MiB memory, no swap, half a CPU, 64 tasks, and 45 seconds by default. It limits captured journal output and cleans up its own unit and the private `TMPDIR` it gives the command (`scripts/run-tmp.mjs`), so fixtures a check leaves behind never reach the shared `/tmp`. It fails rather than falling back to an unbounded process when systemd is unavailable. Explicit `--seconds`, `--memory-mib`, and `--cpu-percent` options adjust limits within the wrapper's validated ranges.

Run one heavy check at a time on a constrained host. Test concurrency only limits runner scheduling; it does not limit memory, CPU, loader children, browser processes, or a runaway render loop. A resource-limit termination is a failed or incomplete check, never a pass. Inspect the failure before increasing limits or retrying. Other hosts need an equivalent enforced process-tree boundary before reproducing a suspected resource-exhaustion failure.

When several agents share a host, "one at a time" must hold across all of them, not per agent: the parent gives every child the same lock file and the children wrap each heavy command in it, for example `flock .scratch/<task>/heavy.lock node scripts/run-bounded-check.mjs --memory-mib 3072 -- <command>` (or the `systemd-run --user --wait --collect -p MemoryMax=… timeout …` equivalent). The lock queues the checks; the cap bounds each one.

Everywhere else (Windows, macOS, a host without systemd), run any multi-file test set through `node scripts/run-tests.mjs <files…>`, never a bare `node --test` over many files. The runner kills the whole test process tree and fails when free memory stays under its floor (10% of RAM, at least 1 GB; `POLYTH_TEST_MIN_FREE_MB` overrides, `0` disables). It is a host-protection backstop, not a per-check limit: on a desktop host the Polyth app and every running agent turn share that memory, and a test that exhausts it crashes them all. `--max-old-space-size` is not a substitute: what the runner serialises between processes lives outside the V8 heap. Run a long test set in the background rather than as a foreground command that blocks the turn for minutes.

Never give a DOM node (happy-dom, jsdom) to `assert` as a value, as in `assert.equal(element, null)`. On failure the runner serialises `actual`, and a node reaches its whole window: one such failure grew a single test process to ~40 GB. Assert a boolean instead (`node === null`) and put a short `outerHTML` excerpt in the message.

Tests that deliberately create separate systemd scopes must bound those fixture
units themselves; they are siblings of the runner's cgroup and do not inherit
its limits. Never use an ordinary runtime or provider launch as an unbounded
substitute. Preserve the wrapper's unique unit name so complete failure output
can be read with `journalctl --user -u <unit>.service`; the displayed journal tail
may omit an early failure.

## Agent-beta rigs run no model turns

A server started with `POLYTH_AGENT_BETA=1` (`scripts/agent-beta.ts`) refuses every provider turn unless `POLYTH_AGENT_BETA_MODEL_TURNS=1` is set. The refusal is the single admission gate in `sessions.ts` (`admitTurnCoreUnfenced`), which every person send, queue drain, watchdog/incomplete/epoch continuation and wake passes through: a person's send fails with "Model turns are off on this test server…", an automatic continuation is refused and logged, and nothing is persisted or left working. Start rigs that need a real turn with the opt-in, and only when paid turns are authorized. Small-model one-shots (titles, commit messages) are not routed through this gate.

## Temporary files

Tests remove the `mkdtemp` fixtures they create (`t.after`/`after` with `rmSync(dir, { recursive: true, force: true })`). `scripts/test/tempHygiene.test.ts` fails for a new test file that calls `mkdtemp` without removing anything; the files that already leaked are listed per test directory in `test/temp-leaks.allowlist.json` (so a removable package carries its own list), and the lists only shrink. Both test wrappers run with a private `TMPDIR` and remove it afterwards; a killed wrapper's directory (`polyth-test-run-*`, owner pid recorded inside) is swept by the next run once its owner has exited and the directory has been untouched for 35 minutes.

## Evidence levels

**Source-inspected**: a definition or code path was read. **Declared**: a flag/interface/config says it exists. **Unit-tested**: deterministic isolated test executed. **Integration-tested**: relevant real boundaries exercised. **Live-verified**: actual runtime/provider executed with known environment. **Device-verified**: affected native behavior exercised on a named device/OS/build. These are not interchangeable or strictly cumulative; state exactly what was checked.

A “pass” belongs to a command, commit/dirty state, environment and behavior—not to a whole product. A fake provider can prove translation and races, not current native authentication. A browser can prove responsive layout, not push delivery. A Rust ticket parser can prove parsing, not iOS pairing. A typecheck can prove static compatibility, not authorization correctness.

## Reuse without overclaiming

Within a task, reuse a check result while its relevant code, inputs, toolchain and environment remain unchanged. Re-run after edits that affect it or integration with another workstream. A source hash or unchanged test filename is not enough for transitive dependency changes. Do not run the full suite after every one-line iteration, and do not stop at a tiny passing test for a broad refactor.

Historical baseline failures require a comparable current base run to classify as pre-existing. Keep unresolved failures visible. Do not alter expected results, allowlists, retry counts or selector exclusions merely to get green. If a required command cannot run, say blocked/not-run and why; a source review does not replace it silently.

## Completion record

Use the evidence template for substantive changes: scope, base/head, changed files, requested behavior, exact commands/cwd, exit/counts, environment, visual/native/provider coverage, remaining limits. Keep logs outside committed docs unless a small redacted fixture is necessary. Do not include secrets, full transcripts or invented test counts.
