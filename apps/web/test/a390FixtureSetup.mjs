// UX-A390 live-gate fixture: isolated, synthetic, disposable.
// Creates a throwaway git project, an isolated Polyth data dir, and seeded
// sessions (empty / loaded / working), then prints the environment the live
// test consumes. It never touches existing runtimes, homes, or data dirs and
// refuses to reuse a pre-existing fixture path.
//
// Usage (from the repo root):
//   node apps/web/test/a390FixtureSetup.mjs
//   npm run build:web
//   env HOME=/tmp/polyth-a390-home-58a2 POLYTH_DATA_DIR=/tmp/polyth-a390-data-58a2 \
//       PORT=4453 node packages/server/src/index.ts
//   POLYTH_LIVE_URL=http://127.0.0.1:4453 ... node --test apps/web/test/responsiveShell.live.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const FIXTURE_ROOT = "/tmp/polyth-a390-fixture-58a2";
const FIXTURE_DATA = "/tmp/polyth-a390-data-58a2";
const FIXTURE_HOME = "/tmp/polyth-a390-home-58a2";
const PROJECT_ID = "a390-project";
const SESSIONS = { empty: "a390-empty", loaded: "a390-loaded", working: "a390-working" };

for (const p of [FIXTURE_ROOT, FIXTURE_DATA, FIXTURE_HOME]) {
  if (existsSync(p)) {
    console.error(`refusing to reuse existing path: ${p}`);
    process.exit(1);
  }
}
for (const p of [FIXTURE_ROOT, FIXTURE_DATA, FIXTURE_HOME]) mkdirSync(p, { recursive: true, mode: 0o700 });
writeFileSync(join(FIXTURE_ROOT, ".ux-fixture-sentinel"), "UX-A390 58a2\n");
writeFileSync(join(FIXTURE_DATA, ".ux-fixture-sentinel"), "UX-A390 58a2\n");
writeFileSync(join(FIXTURE_HOME, ".ux-fixture-sentinel"), "UX-A390 58a2\n");

// --- synthetic project repository (no remote, synthetic identity) ----------
mkdirSync(join(FIXTURE_ROOT, "src"), { recursive: true });
writeFileSync(join(FIXTURE_ROOT, "README.md"), "# A390 synthetic fixture\n\nDisposable repository for the UX-A390 responsive live gate.\n");
writeFileSync(join(FIXTURE_ROOT, "src/index.ts"), "export const greet = (name: string): string => `hello ${name}`;\n");
writeFileSync(join(FIXTURE_ROOT, "src/util.ts"), "export const twice = (n: number): number => n * 2;\n");
writeFileSync(join(FIXTURE_ROOT, "notes.md"), "Synthetic notes file.\n");
const git = (...args) => execFileSync("git", ["-C", FIXTURE_ROOT, ...args], { stdio: "pipe" });
git("init", "-b", "main");
git("config", "user.name", "UX A390 Fixture Bot");
git("config", "user.email", "a390-fixture@example.invalid");
git("config", "commit.gpgsign", "false");
git("add", "-A");
git("commit", "-m", "chore: seed synthetic A390 fixture");
// One unstaged edit so the Changes panel has content.
writeFileSync(join(FIXTURE_ROOT, "notes.md"), "Synthetic notes file.\n\nUnstaged synthetic edit for the Changes panel.\n");

// --- isolated Polyth data: project registry + seeded session log -----------
writeFileSync(join(FIXTURE_DATA, "projects.json"), JSON.stringify([{
  id: PROJECT_ID,
  path: FIXTURE_ROOT,
  name: "A390 Responsive Fixture",
  createdAt: Date.now(),
}], null, 2));

const { createStore } = await import(join(repoRoot, "packages/session/src/index.ts"));
const store = createStore(join(FIXTURE_DATA, "sessions.db"));
const now = Date.now();

const projection = (id, title, status, extra = {}) => ({
  id, projectId: PROJECT_ID, title, status,
  createdAt: now - 60_000, updatedAt: now, ...extra,
});

// Empty session: created, zero messages.
await store.append(SESSIONS.empty, "session/created", { title: "Empty synthetic session" });
await store.upsertProjection(projection(SESSIONS.empty, "Empty synthetic session", "idle"));

// Loaded session: several finalized turns so the timeline scrolls.
await store.append(SESSIONS.loaded, "session/created", { title: "Loaded synthetic timeline" });
for (let i = 1; i <= 6; i++) {
  await store.append(SESSIONS.loaded, "user/message", { text: `Synthetic prompt ${i}: describe the fixture module src/util.ts in a few sentences.` });
  await store.append(SESSIONS.loaded, "turn/started", { turnId: `a390-turn-${i}` });
  await store.append(SESSIONS.loaded, "assistant/message", {
    partId: `a390-part-${i}`,
    text: `Synthetic reply ${i}. The fixture module exports a small pure helper used only by this disposable repository. `.repeat(6),
  });
  await store.append(SESSIONS.loaded, "turn/stopped", { turnId: `a390-turn-${i}`, reason: "completed" });
}
await store.upsertProjection(projection(SESSIONS.loaded, "Loaded synthetic timeline", "idle"));

// Working session: an open turn (inert replay data — no real model runs), so
// the composer shows the Queue/Steer/Interrupt + Stop working controls.
await store.append(SESSIONS.working, "session/created", { title: "Working synthetic analysis" });
await store.append(SESSIONS.working, "user/message", { text: "Synthetic long-running request: analyze the fixture." });
await store.append(SESSIONS.working, "turn/started", { turnId: "a390-turn-working" });
await store.append(SESSIONS.working, "assistant/chunk", { partId: "a390-part-working", text: "Analyzing synthetic files…" });
await store.upsertProjection(projection(SESSIONS.working, "Working synthetic analysis", "working"));

await store.close();

console.log("A390 fixture ready.");
console.log(`export POLYTH_LIVE_PROJECT_ID=${PROJECT_ID}`);
console.log(`export POLYTH_LIVE_SESSION_EMPTY=${SESSIONS.empty}`);
console.log(`export POLYTH_LIVE_SESSION_LOADED=${SESSIONS.loaded}`);
console.log(`export POLYTH_LIVE_SESSION_WORKING=${SESSIONS.working}`);
console.log(`# data: ${FIXTURE_DATA}  home: ${FIXTURE_HOME}  repo: ${FIXTURE_ROOT}`);
