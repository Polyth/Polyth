# Disposable UX audit fixture specification

- Case: `UX-FIXTURE-SPEC`
- Owner of implementation: Fable fixture-builder
- Fixture kind: isolated, synthetic, disposable

## Safety contract

The builder must create a new repository and new runtime data only at the exact
paths below. It must not add the fixture to an existing runtime, reuse an
existing data directory, inspect or copy user session data, copy credentials,
configure a Git remote, or run Git commands in the Polyth source repository.

```sh
export POLYTH_SOURCE=/workspace
export FIXTURE_ROOT=/tmp/polyth-ux-fixture-58a2
export WORKTREE_ROOT=/tmp/polyth-ux-fixture-worktree-58a2
export FIXTURE_HOME=/tmp/polyth-ux-fixture-home-58a2
export FIXTURE_DATA=/tmp/polyth-ux-fixture-data-58a2
export POLYTH_FIXTURE_PORT=4418
export FIXTURE_DEV_PORT=43158
export POLYTH_FIXTURE_URL=http://127.0.0.1:4418
export FIXTURE_DEV_URL=http://127.0.0.1:43158
export POLYTH_TMUX=polyth-ux-fixture-58a2
export FIXTURE_DEV_TMUX=ux-fixture-dev-58a2
umask 077
```

Before creating anything, require `POLYTH_SOURCE/package.json` and
`POLYTH_SOURCE/packages/session/src/index.ts` to exist. Refuse to proceed if
any of `FIXTURE_ROOT`, `WORKTREE_ROOT`, `FIXTURE_HOME`, or `FIXTURE_DATA`
already exists. Do not delete or adopt a pre-existing path. Create each path
with mode `0700`, and put a file named `.ux-fixture-sentinel` containing
`UX-FIXTURE-SPEC 58a2` in `FIXTURE_ROOT`, `FIXTURE_HOME`, and `FIXTURE_DATA`.

All names, messages, file contents, Git identity, browser input, and sessions
are synthetic. The repository has no remote. No `.env`, token, key, cookie,
credential, authorization header, or user-derived content is permitted.
Processes bind to `127.0.0.1`, never `0.0.0.0`.

## Ports

| Purpose | Port | Constraint |
|---|---:|---|
| Isolated Polyth fixture runtime | `4418` | loopback only |
| Fixture project's dev server | `43158` | loopback only |
| Existing Polyth | `4400` | protected; do not bind or stop |
| Bootstrapped Polyth | `4401` | protected; do not bind or stop |
| Existing polyth | `8888` | protected; do not bind or stop |
| Bootstrapped polyth | `8889` | protected; do not bind or stop |

Before launch, bind-test `4418` and `43158` on `127.0.0.1` and fail if either
is occupied. Do not select a fallback port because the audit URLs must remain
deterministic. OpenCode may use its existing free-port allocation; its
`HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `OPENCODE_CONFIG_DIR` must all
point inside `FIXTURE_HOME`.

## Exact final layout

`FIXTURE_ROOT` is the primary Git checkout. Status annotations describe the
required final state and are not part of filenames.

```text
/tmp/polyth-ux-fixture-58a2/
├── .agents/
│   └── loops/
│       ├── invalid-cron.md
│       ├── invalid-id.md
│       └── weekly-review.md
├── .git/                                  (generated; merge remains conflicted)
├── .gitignore
├── .ux-fixture-sentinel
├── README.md
├── assets/
│   └── pixel.png                          (committed binary 1×1 PNG)
├── conflict.txt                           (UU; conflict markers present)
├── data/
│   └── sample.json                        (committed valid JSON)
├── docs/
│   ├── history.md                         (committed from merged branch)
│   ├── mainline.md                        (committed on main)
│   ├── oversized.md                       (committed UTF-8, >512 KiB)
│   ├── renamed-guide.md                   (R staged from rename-me.md)
│   └── unstaged.md                        (M unstaged)
├── notes/
│   └── untracked.txt                      (untracked)
├── package.json
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── scripts/
│   └── seed-sessions.mjs
├── server.mjs
└── src/
    ├── index.ts
    ├── nested/
    │   └── deep/
    │       └── config.json                (M unstaged; valid JSON)
    └── staged.ts                          (M staged)
```

`WORKTREE_ROOT` is a clean attached checkout of branch `fixture/worktree`. It
contains the committed tree above as it existed immediately after the merge
commit, plus committed `docs/worktree-note.md`. Its `.git` is the normal Git
worktree pointer file. It does not contain the primary checkout's later dirty
or conflicted changes.

Generated runtime-only state is outside both Git checkouts:

```text
/tmp/polyth-ux-fixture-data-58a2/
├── .ux-fixture-sentinel
├── projects.json
└── sessions.db                            (WAL/SHM sidecars may appear)

/tmp/polyth-ux-fixture-home-58a2/
├── .ux-fixture-sentinel
├── .config/
├── .local/share/
└── opencode/
```

## File content requirements

### Project and source

`package.json` must be private, have `"type": "module"`, have no dependencies,
and expose only `"dev": "node server.mjs"`. `README.md` must identify the
repository as synthetic and disposable. `.gitignore` contains only
`node_modules/` and `*.log`.

`src/index.ts` exports a small typed `formatGreeting(name: string): string`.
`src/staged.ts` starts with one exported constant. `src/nested/deep/config.json`
starts as valid JSON with `{"surface":"files","depth":3,"state":"baseline"}`.
`data/sample.json` is valid, pretty-printed JSON containing only synthetic
records.

`assets/pixel.png` is a deterministic valid 1×1 PNG, not random bytes.
`docs/oversized.md` begins with `# Oversized synthetic document` and is filled
with repeated synthetic text until its byte size is at least `614400` and less
than `1048576`. This intentionally crosses Polyth's 512 KiB text-read limit
without creating a wasteful multi-megabyte artifact.

### Local dev server

`server.mjs` uses Node built-ins only. It:

- listens on `HOST` (default `127.0.0.1`) and `PORT` (default `43158`);
- serves `public/index.html`, `public/app.js`, and `public/styles.css`;
- responds to `GET /api/echo?value=...` with
  `{"ok":true,"echo":"<bounded value>","source":"ux-fixture"}`;
- clips `value` to 200 Unicode code points, sends `Cache-Control: no-store`,
  returns JSON 404 for unknown routes, and never writes request data to disk;
- prints one startup line containing the exact resolved loopback URL.

`public/index.html` contains one labelled text input `#fixture-input`, one
button `#fixture-submit`, and one live output region `#fixture-output`.
`public/app.js` handles the button and Enter key, performs a same-origin
`fetch("/api/echo?...")`, writes the response using `textContent`, and emits
`console.info("ux-fixture response", payload)`. The page therefore provides a
real input interaction, a button action, browser console output, and a visible
network request without contacting any external host.

### Portable loops

`.agents/loops/weekly-review.md` is valid:

```md
---
id: weekly-review
title: Weekly synthetic review
cron: "0 9 * * 1"
timeZone: "UTC"
enabled: true
agentProfile: review
---
Review only this disposable fixture and summarize its synthetic changes.
```

`.agents/loops/invalid-cron.md` uses lowercase id `invalid-cron`, non-empty
body text, and `cron: "@daily"` so the expected error is specifically the
unsupported cron alias. `.agents/loops/invalid-id.md` uses `id: Invalid_ID`,
a valid five-field cron, and non-empty body text so the expected error is
specifically the lowercase-id rule. All three are ordinary files, not
symlinks.

## Exact Git construction

Fable must first create all baseline files listed above except
`docs/renamed-guide.md`, `notes/untracked.txt`, and
`docs/worktree-note.md`. At baseline, create `docs/rename-me.md`,
`docs/unstaged.md`, `docs/history.md`, `docs/mainline.md`, and
`conflict.txt` with short synthetic content. Then run exactly this Git
sequence from `FIXTURE_ROOT`:

```sh
git init -b main
git config user.name "UX Fixture Bot"
git config user.email "ux-fixture@example.invalid"
git config commit.gpgsign false
git add -A
git commit -m "chore: seed synthetic UX fixture"

git switch -c fixture/merge-source
printf '\nMerged branch contribution.\n' >> docs/history.md
git add docs/history.md
git commit -m "docs: add merged fixture history"

git switch main
printf '\nMainline contribution.\n' >> docs/mainline.md
git add docs/mainline.md
git commit -m "docs: add mainline fixture note"
git merge --no-ff fixture/merge-source -m "merge: combine fixture history"

git branch fixture/worktree
git worktree add "$WORKTREE_ROOT" fixture/worktree
printf '# Worktree fixture\n\nSynthetic attached-worktree content.\n' \
  > "$WORKTREE_ROOT/docs/worktree-note.md"
git -C "$WORKTREE_ROOT" add docs/worktree-note.md
git -C "$WORKTREE_ROOT" commit -m "docs: add worktree fixture note"

git switch -c fixture/conflict-side
printf 'mode: conflict-side\nmessage: synthetic branch value\n' > conflict.txt
git add conflict.txt
git commit -m "test: add conflict-side value"

git switch main
printf 'mode: main\nmessage: synthetic main value\n' > conflict.txt
git add conflict.txt
git commit -m "test: add conflicting main value"
if git merge --no-ff fixture/conflict-side -m "merge: retain fixture conflict"; then
  echo "expected merge conflict did not occur" >&2
  exit 1
fi
test -f .git/MERGE_HEAD
git ls-files -u -- conflict.txt | test "$(wc -l)" -eq 3

printf '\nexport const stagedChange = "staged synthetic change";\n' >> src/staged.ts
git add src/staged.ts

mv docs/rename-me.md docs/renamed-guide.md
git add -A -- docs/rename-me.md docs/renamed-guide.md

printf '\nUnstaged synthetic edit.\n' >> docs/unstaged.md
printf '%s\n' \
  '{"surface":"files","depth":3,"state":"nested-unstaged"}' \
  > src/nested/deep/config.json
mkdir -p notes
printf 'Synthetic untracked note.\n' > notes/untracked.txt
```

Do not resolve or abort the merge. Do not commit the final six working-tree
states. The required branches are `main`, `fixture/merge-source`,
`fixture/conflict-side`, and `fixture/worktree`. `main` must contain a true
two-parent merge commit from `fixture/merge-source`; `fixture/worktree` must
remain checked out only at `WORKTREE_ROOT`.

The final `git status --porcelain=v1 --untracked-files=all` must contain exactly
these semantic states (Git may sort rows, but no extra row is allowed):

```text
UU conflict.txt
R  docs/rename-me.md -> docs/renamed-guide.md
 M docs/unstaged.md
 M src/nested/deep/config.json
M  src/staged.ts
?? notes/untracked.txt
```

## Isolated session seed

`scripts/seed-sessions.mjs` is a fixture-only offline seeder. It must fail
unless all four root environment variables match the exact `/tmp/...-58a2`
paths and both data/root sentinels are present. It dynamically imports
`createStore` from
`$POLYTH_SOURCE/packages/session/src/index.ts`, writes only
`$FIXTURE_DATA/projects.json` and `$FIXTURE_DATA/sessions.db`, and closes the
store before exit. It performs no network requests and starts no backend.

Write one project record:

```json
{
  "id": "ux-fixture-project",
  "path": "/tmp/polyth-ux-fixture-58a2",
  "name": "Disposable UX Fixture",
  "createdAt": "<seed time>"
}
```

Append each session's events before upserting its projection. Use the fixed
session ids and exact terminal states below. Timestamps may be relative to the
seed time so the sidebar has useful recent ordering.

| Session id | Title | Projection status | Required event tail / metadata |
|---|---|---|---|
| `fixture-idle` | `Idle — synthetic review complete` | `idle` | `session/created`, safe `user/message`, finalized `assistant/message`, `turn/stopped` with `reason:"completed"` |
| `fixture-working` | `Working — synthetic analysis` | `working` | `session/created`, safe `user/message`, `turn/started`, then one `assistant/chunk` saying it is analyzing synthetic files; no stopped event |
| `fixture-permission` | `Permission — read fixture guide` | `waiting` | `session/created`, `turn/started`, unresolved `permission/requested` |
| `fixture-question` | `Question — choose sample view` | `waiting` | `session/created`, `turn/started`, unresolved `question/asked` |
| `fixture-archived` | `Archived — completed synthetic task` | `archived` | completed safe exchange followed by `session/archived` |
| `fixture-worktree` | `Worktree — isolated branch` | `idle` | `session/created` with worktree path; projection fields below |

No projection may contain `backendSessionId`. The working and waiting states
are inert replay data, not real model turns. The permission request must be:

```json
{
  "requestId": "permission-fixture-read",
  "permission": "read",
  "patterns": ["docs/renamed-guide.md"],
  "tool": "read",
  "preview": {
    "title": "Read fixture guide",
    "lines": ["docs/renamed-guide.md"],
    "risk": "low"
  },
  "allowedScopes": ["once", "session", "project"]
}
```

The question request id is `question-fixture-view`. It contains two safe
questions: a required single-choice question (`files`, `git`, `preview`) and
an optional text question for a synthetic label. It must not request personal,
account, authentication, or production information.

The worktree projection must set:

```json
{
  "worktreePath": "/tmp/polyth-ux-fixture-worktree-58a2",
  "worktreeId": "/tmp/polyth-ux-fixture-worktree-58a2",
  "worktreeState": "ready",
  "branch": "fixture/worktree"
}
```

Run the seeder once, before starting Polyth:

```sh
env \
  POLYTH_SOURCE="$POLYTH_SOURCE" \
  FIXTURE_ROOT="$FIXTURE_ROOT" \
  WORKTREE_ROOT="$WORKTREE_ROOT" \
  FIXTURE_DATA="$FIXTURE_DATA" \
  node "$FIXTURE_ROOT/scripts/seed-sessions.mjs"
```

## Launch

Use persistent, separately named tmux sessions. If
`/exec-daemon/tmux.portal.conf` exists, pass it with `tmux -f`; otherwise use
the default tmux configuration. Refuse to reuse either session name.

Launch the project dev server from `FIXTURE_ROOT`:

```sh
env HOST=127.0.0.1 PORT="$FIXTURE_DEV_PORT" npm run dev
```

Launch the isolated Polyth runtime from `POLYTH_SOURCE`:

```sh
env \
  HOME="$FIXTURE_HOME" \
  XDG_CONFIG_HOME="$FIXTURE_HOME/.config" \
  XDG_DATA_HOME="$FIXTURE_HOME/.local/share" \
  OPENCODE_CONFIG_DIR="$FIXTURE_HOME/opencode" \
  POLYTH_DATA_DIR="$FIXTURE_DATA" \
  NODE_OPTIONS=--experimental-strip-types \
  PORT="$POLYTH_FIXTURE_PORT" \
  npm start
```

Do not alter or stop services on `4400`, `4401`, `8888`, or `8889`. Leave both
fixture services running after validation for the visual audit.

## Acceptance checks

Fable must run these checks and retain their output for handoff:

1. `git status --porcelain=v1 --untracked-files=all` has exactly the six rows
   specified above.
2. `git log --merges --format='%H %P %s' main` contains
   `merge: combine fixture history` with exactly two parents.
3. `git branch --format='%(refname:short)'` contains exactly the four required
   local branches.
4. `git worktree list --porcelain` shows the primary checkout and
   `WORKTREE_ROOT`; the latter is on `refs/heads/fixture/worktree`.
5. `file assets/pixel.png` identifies PNG image data, and
   `wc -c docs/oversized.md` is in `[614400,1048576)`.
6. Parsing with `scanLoopsDir(FIXTURE_ROOT)` returns one healthy loop and two
   errors: cron alias for `invalid-cron.md`, lowercase identifier for
   `invalid-id.md`.
7. `curl -fsS "$FIXTURE_DEV_URL/"` contains `fixture-input`,
   `fixture-submit`, and `fixture-output`.
8. `curl -fsS "$FIXTURE_DEV_URL/api/echo?value=hello"` returns
   `ok:true`, `echo:"hello"`, and `source:"ux-fixture"`.
9. `curl -fsS "$POLYTH_FIXTURE_URL/api/health"` returns `ok:true`.
10. `GET /api/projects` returns only `ux-fixture-project`; querying
    `/api/sessions?projectId=ux-fixture-project` returns exactly six sessions
    with statuses `idle`, `working`, `waiting`, `waiting`, `archived`, `idle`.
11. No Git remote exists, no tracked or untracked `.env` exists, and all
    listeners owned by the fixture bind only to loopback.

## Teardown

Teardown is a deliberate post-audit action, not part of construction. It may
run only after verifying all three sentinels and exact path strings. Stop only
the two exact fixture tmux sessions, remove `WORKTREE_ROOT` through
`git -C "$FIXTURE_ROOT" worktree remove --force "$WORKTREE_ROOT"`, then remove
the four exact fixture directories. Never use a wildcard, process-name kill,
or cleanup command rooted above one of those exact paths.

## Non-goals

- No real provider/model turn, credential setup, external API, or internet
  request.
- No reuse or mutation of existing Polyth/polyth projects, homes, data,
  sessions, ports, tmux sessions, or worktrees.
- No Git remote, fetch, pull, push, signed commit, stash, or conflict
  resolution.
- No malicious files, secret-shaped strings, symlink escapes, executable
  downloads, auth testing, notification delivery, voice/media capture, or
  destructive permission request.
- No dependency installation in the fixture and no production code change.
- No visual pass/fail judgment; this fixture supplies deterministic states for
  the separate UX audit.
