// UX-COMPOSER-DISC live-gate fixture: isolated, synthetic, disposable.
// Builds a throwaway git project whose capability truth the gate asserts:
// two real project commands under .polyth/commands, NO snippets (a successful
// empty catalog), searchable source files for @ mention, and a GitHub remote
// answered by a deterministic `gh` shim so the link-attach probe never
// touches the network. The isolated Polyth data dir seeds one empty idle
// session and one open-turn (working) session; the model runtime is the
// synthetic msgActionsFakeBackend on PATH. Existing fixture paths are wiped
// only when they carry the sentinel — anything else refuses.
//
// Usage: imported by composerDiscovery.live.ts (buildComposerDiscFixture()),
//        or run directly: node apps/web/test/composerDiscFixtureSetup.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

export const FIXTURE_ROOT = "/tmp/polyth-compdisc-fixture-58a2";
export const FIXTURE_DATA = "/tmp/polyth-compdisc-data-58a2";
export const FIXTURE_HOME = "/tmp/polyth-compdisc-home-58a2";
export const FIXTURE_BIN = "/tmp/polyth-compdisc-bin-58a2";
export const OC_SEED = join(FIXTURE_DATA, "oc-seed.json");
export const OC_STATE = join(FIXTURE_DATA, "oc-state.json");
export const PROJECT_ID = "compdisc-project";

/** Remote the `gh` shim reports; the matching/mismatching link URLs derive
 *  from it. Entirely synthetic — the repository does not exist anywhere. */
export const GH_OWNER = "synthetic";
export const GH_NAME = "compdisc";

export const SESSIONS = {
  /** Empty idle session — the main discovery surface. */
  main: "disc-main",
  /** Open turn (working) — delivery copy + separate Stop. */
  active: "disc-active",
};

const SENTINEL = ".ux-fixture-sentinel";

const resetDir = (path) => {
  if (existsSync(path)) {
    if (!existsSync(join(path, SENTINEL))) {
      throw new Error(`refusing to wipe non-fixture path: ${path}`);
    }
    rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(path, SENTINEL), "UX-COMPOSER-DISC 58a2\n");
};

export async function buildComposerDiscFixture() {
  for (const p of [FIXTURE_ROOT, FIXTURE_DATA, FIXTURE_HOME, FIXTURE_BIN]) resetDir(p);

  // --- synthetic project repository -----------------------------------------
  writeFileSync(join(FIXTURE_ROOT, "README.md"),
    "# COMPOSER-DISC synthetic fixture\n\nDisposable repository for the composer discovery live gate.\n");
  mkdirSync(join(FIXTURE_ROOT, "src/beta"), { recursive: true });
  writeFileSync(join(FIXTURE_ROOT, "src/alpha.ts"), "export const alpha = 1;\n");
  writeFileSync(join(FIXTURE_ROOT, "src/beta/notes.md"), "# beta notes\n");

  // Two real project commands; NO snippets directory (a successful empty
  // snippet catalog is part of the truth model under test).
  mkdirSync(join(FIXTURE_ROOT, ".polyth/commands"), { recursive: true });
  writeFileSync(join(FIXTURE_ROOT, ".polyth/commands/plan.md"),
    "---\ndescription: Draft a synthetic plan\n---\nDraft a plan for $ARGUMENTS\n");
  writeFileSync(join(FIXTURE_ROOT, ".polyth/commands/review.md"),
    "---\ndescription: Review synthetic changes\n---\nReview the latest changes\n");

  const git = (...args) => execFileSync("git", ["-C", FIXTURE_ROOT, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Composer Disc Fixture Bot");
  git("config", "user.email", "compdisc-fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", `https://github.com/${GH_OWNER}/${GH_NAME}.git`);
  git("add", "-A");
  git("commit", "-m", "chore: seed synthetic composer-disc fixture");

  // --- fake model runtime binary on PATH -------------------------------------
  const fake = join(here, "msgActionsFakeBackend.mjs");
  const ocWrapper = join(FIXTURE_BIN, "opencode");
  writeFileSync(ocWrapper, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(ocWrapper, 0o755);

  // --- deterministic `gh` shim ------------------------------------------------
  // The Polyth server probes the project repository by exec'ing `gh`. The shim
  // answers `repo view --json …` with the synthetic remote identity and
  // succeeds on `--version` / `auth status`; anything else fails. The live
  // gate therefore never performs a real GitHub request.
  const ghShim = join(FIXTURE_BIN, "gh");
  writeFileSync(ghShim, `#!/bin/sh
case "$1" in
  --version) echo "gh version 0.0.0-compdisc-shim"; exit 0 ;;
  auth) exit 0 ;;
  repo)
    cat <<'JSON'
{"name":"${GH_NAME}","owner":{"login":"${GH_OWNER}"},"url":"https://github.com/${GH_OWNER}/${GH_NAME}","description":"synthetic fixture","defaultBranchRef":{"name":"main"},"isPrivate":false}
JSON
    exit 0 ;;
  *) echo "compdisc gh shim: unsupported: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(ghShim, 0o755);

  // --- backend seed -----------------------------------------------------------
  // oc_active hangs on prompts so the working session can never complete
  // underneath the gate's active-turn assertions.
  writeFileSync(OC_SEED, JSON.stringify({
    sessions: [
      { id: "oc_active", title: "Active synthetic turn", turnBehavior: "hang", messages: [] },
    ],
  }, null, 2));

  // --- isolated Polyth data: project registry + seeded session logs ----------
  writeFileSync(join(FIXTURE_DATA, "projects.json"), JSON.stringify([{
    id: PROJECT_ID,
    path: FIXTURE_ROOT,
    name: "Composer Disc Fixture",
    createdAt: Date.now(),
  }], null, 2));

  const { createStore } = await import(join(REPO_ROOT, "packages/session/src/index.ts"));
  const store = createStore(join(FIXTURE_DATA, "sessions.db"));
  const now = Date.now();
  const projection = (id, title, status, extra = {}) => ({
    id, projectId: PROJECT_ID, title, status,
    createdAt: now - 3_600_000, updatedAt: now, ...extra,
  });

  // Main surface: created, zero messages, idle.
  await store.append(SESSIONS.main, "session/created", { title: "Discovery surface" }, { ignorable: true });
  await store.upsertProjection(projection(SESSIONS.main, "Discovery surface", "idle"));

  // Active turn: inert replay data — no real model runs.
  await store.append(SESSIONS.active, "session/created", { title: "Active synthetic turn" }, { ignorable: true });
  await store.append(SESSIONS.active, "user/message", { text: "Synthetic prompt holding an open turn." });
  await store.append(SESSIONS.active, "turn/started", { turnId: "disc-active-t1" }, { ignorable: true });
  await store.append(SESSIONS.active, "assistant/chunk", { partId: "disc-active-p1", text: "Working on the synthetic prompt…" });
  await store.upsertProjection(projection(SESSIONS.active, "Active synthetic turn", "working", { backendSessionId: "oc_active" }));

  await store.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await buildComposerDiscFixture();
  console.log("COMPOSER-DISC fixture ready.");
  console.log(`# project: ${PROJECT_ID}  data: ${FIXTURE_DATA}  home: ${FIXTURE_HOME}  bin: ${FIXTURE_BIN}`);
}
