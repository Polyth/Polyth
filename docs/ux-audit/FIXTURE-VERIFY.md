# Fixture builder verification

- Case: `UX-FIXTURE-BUILD`
- Artifact inspected: `/tmp/polyth-ux-fixture-58a2`
- Fixture commit: `6bd4f8ba3ce8d2b0320848b59f9d71df5f7e6d43`
- Specification: `docs/ux-audit/FIXTURE-SPEC.md` at
  `183da3638b00bc74058a71bc751680220a3b88a2`
- Verdict: **verified**

## Independent verification

- The primary checkout is at the stated Fable commit, has no remote, has
  exactly the four required branches, and reports exactly the six specified
  conflict, staged, unstaged, rename, and untracked states. The required
  two-parent merge exists. The attached `fixture/worktree` checkout is clean
  and contains only its committed worktree note beyond the merged tree.
- Exhaustive traversal of the four fixture trees matches the reconciled
  layout, including only the permitted database WAL/SHM sidecars. All roots
  are mode `0700`, all sentinels are exact, every listed empty directory is
  empty, and no symlink exists. The guard is mode `0600` and byte-for-byte
  matches the specification.
- The live Polyth pane runs the exact isolated `env ... npm start` launch. Its
  process chain is `npm start` to the package-script shell to
  `node packages/server/src/index.ts`; it has no direct-node or command-line
  preload launch. `NODE_OPTIONS` is exactly
  `--experimental-strip-types --import=file:///tmp/polyth-ux-fixture-home-58a2/loopback-listen.mjs`,
  so the specified guard is the only preload. The runtime owns only
  `127.0.0.1:4418`.
- The project pane runs `env HOST=127.0.0.1 PORT=43158 npm run dev` and owns
  only `127.0.0.1:43158`. Protected listeners remain outside both fixture
  process trees.
- The PNG is a valid deterministic 1x1 image and `docs/oversized.md` is
  620632 bytes. JSON files parse. Production `scanLoopsDir` returns the one
  healthy loop and exactly the cron-alias and lowercase-id errors.
- Live checks pass for the page markers, no-store responses, JSON 404, exact
  echo response, and 200-Unicode-code-point bound. Polyth health is true.
  Runtime APIs return only the synthetic project and the six exact session
  projections, statuses, event tails, unresolved requests, and worktree
  metadata; no projection has `backendSessionId`.
- `model-visibility.json` has empty disabled lists, `schedule.json` contains
  only the synthetic `weekly-review` loop-file task, and the knowledge store
  has zero rows. No `.env` file, secret-shaped text, additional preload,
  external listener, or non-synthetic session content was found.

No blocking conformance finding remains. Leave both fixture services running
for the separate visual audit.
