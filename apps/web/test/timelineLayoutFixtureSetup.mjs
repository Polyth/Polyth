// UX-TIMELINE-LAYOUT-01 live-gate fixture: isolated, synthetic, disposable.
// Builds a throwaway git project, an isolated Polyth data dir with seeded
// session logs covering the layout gate's states — a rich mixed-content
// conversation (markdown, code, long URL, RTL, reasoning, tool work, usage
// footer), a >150-row session for suffix-window/anchor gates, an empty
// session, and a stream-capable session whose fake backend emits growing
// snapshots — plus a bin dir whose `opencode` wrapper launches the shared
// synthetic fake (msgActionsFakeBackend.mjs, `turnBehavior: "stream"`).
// Existing fixture paths are wiped only when they carry the sentinel.
//
// Usage: imported by timelineLayout.live.ts (buildTimelineLayoutFixture()),
//        or run directly: node apps/web/test/timelineLayoutFixtureSetup.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

export const FIXTURE_ROOT = "/tmp/polyth-tl01-fixture-9c41";
export const FIXTURE_DATA = "/tmp/polyth-tl01-data-9c41";
export const FIXTURE_HOME = "/tmp/polyth-tl01-home-9c41";
export const FIXTURE_BIN = "/tmp/polyth-tl01-bin-9c41";
export const OC_SEED = join(FIXTURE_DATA, "oc-seed.json");
export const OC_STATE = join(FIXTURE_DATA, "oc-state.json");
export const PROJECT_ID = "tl01-project";

export const SESSIONS = {
  rich: "tl01-rich",
  many: "tl01-many",
  empty: "tl01-empty",
  stream: "tl01-stream",
};

/** How many user/assistant turns the many-rows session seeds (2 rows each —
 *  strictly more than the 150-row suffix window). */
export const MANY_TURNS = 90;

// Deterministic synthetic conversation for the rich session. Every string is
// synthetic; the RTL pair exercises dir=auto and logical alignment.
export const TEXTS = {
  u1: "Outline the timeline layout fixture and list what it must cover.",
  a1: [
    "The synthetic fixture covers the required content states:",
    "",
    "- ordinary markdown prose with a **bold** and an *italic* span",
    "- a nested list level\n  - inner item one\n  - inner item two",
    "- a final paragraph long enough to wrap across several rendered lines so",
    "  the centered reading measure and the unboxed assistant prose are both",
    "  observable at every audited viewport width and zoom level.",
  ].join("\n"),
  u2: "Show a fenced code block wider than the reading column.",
  a2: [
    "Here is an intrinsically wide fenced block; only it may scroll:",
    "",
    "```ts",
    "export const wide = (a: number, b: number, c: number, d: number, e: number, f: number, g: number): number => a + b + c + d + e + f + g; // deliberately-long-single-line-to-force-internal-horizontal-scrolling",
    "```",
    "",
    "The page itself must never scroll horizontally.",
  ].join("\n"),
  reasoning: "Synthetic reasoning: check the wide block against the overflow contract before answering.",
  u3: "Paste a long unbroken URL so wrapping is observable.",
  a3: `The long token wraps without page overflow: https://example.invalid/synthetic/${"segment/".repeat(18)}${"x".repeat(160)}`,
  u4: "ما هو سلوك النص من اليمين إلى اليسار في هذا المخطط؟",
  a4: "النص العربي يلتف بشكل صحيح داخل عمود القراءة، ويحافظ التخطيط على المحاذاة المنطقية دون أي تمرير أفقي للصفحة.",
  u5: "Run the synthetic tool and summarize its output.",
  a5: "The synthetic tool listed two files; the work card above stays chronological and collision-free.",
  u6: "Close the conversation with a final summary.",
  a6: "Final synthetic summary: every content state rendered inside the centered measure with the reserved utilities outside the scroll root.",
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
  writeFileSync(join(path, SENTINEL), "UX-TIMELINE-LAYOUT-01 9c41\n");
};

export async function buildTimelineLayoutFixture() {
  for (const p of [FIXTURE_ROOT, FIXTURE_DATA, FIXTURE_HOME, FIXTURE_BIN]) resetDir(p);

  // --- synthetic project repository (no remote, synthetic identity) --------
  writeFileSync(join(FIXTURE_ROOT, "README.md"), "# TIMELINE-LAYOUT synthetic fixture\n\nDisposable repository for the timeline layout live gate.\n");
  const git = (...args) => execFileSync("git", ["-C", FIXTURE_ROOT, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Timeline Layout Fixture Bot");
  git("config", "user.email", "tl01-fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-m", "chore: seed synthetic timeline-layout fixture");

  // --- fake backend binary on PATH (shared synthetic fake) -------------------
  const fake = join(here, "msgActionsFakeBackend.mjs");
  const wrapper = join(FIXTURE_BIN, "opencode");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(wrapper, 0o755);

  // --- backend seed: only the stream session talks to the fake ---------------
  writeFileSync(OC_SEED, JSON.stringify({
    sessions: [
      {
        id: "oc_tl_stream",
        title: "Streaming layout session",
        turnBehavior: "stream",
        messages: [
          { id: "st_u1", role: "user", text: "Warm-up prompt before the streaming gate." },
          { id: "st_a1", role: "assistant", text: "Settled synthetic answer before any live stream." },
        ],
      },
    ],
  }, null, 2));

  // --- isolated Polyth data: project registry + seeded session logs --------
  writeFileSync(join(FIXTURE_DATA, "projects.json"), JSON.stringify([{
    id: PROJECT_ID,
    path: FIXTURE_ROOT,
    name: "Timeline Layout Fixture",
    createdAt: Date.now(),
  }], null, 2));

  const { createStore } = await import(join(REPO_ROOT, "packages/session/src/index.ts"));
  const store = createStore(join(FIXTURE_DATA, "sessions.db"));
  const now = Date.now();

  const projection = (id, title, status, extra = {}) => ({
    id, projectId: PROJECT_ID, title, status,
    createdAt: now - 7_200_000, updatedAt: now, ...extra,
  });

  const turn = async (id, n, userText, assistantText, opts = {}) => {
    await store.append(id, "user/message", { text: userText });
    await store.append(id, "turn/started", { turnId: `${id}-t${n}` }, { ignorable: true });
    if (opts.reasoning) {
      await store.append(id, "assistant/message", { partId: `${id}-p${n}r`, text: "", reasoning: opts.reasoning });
    }
    if (opts.tool) {
      await store.append(id, "tool/call", { callId: `${id}-c${n}`, tool: "list", input: { path: "." } });
      await store.append(id, "tool/result", { callId: `${id}-c${n}`, tool: "list", output: "README.md\nfixture.txt" });
    }
    await store.append(id, "assistant/message", { partId: `${id}-p${n}`, text: assistantText });
    if (opts.usage) {
      await store.append(id, "usage/recorded", {
        model: { providerID: "synthetic", modelID: "fable-mini" },
        tokens: { input: 512, output: 128 },
        cost: 0.02,
      }, { ignorable: true });
    }
    await store.append(id, "turn/stopped", { turnId: `${id}-t${n}`, reason: "completed" }, { ignorable: true });
  };

  // Rich mixed-content session: markdown, reasoning+code, long URL, RTL,
  // tool work, and a final turn that owns the usage footer.
  await store.append(SESSIONS.rich, "session/created", { title: "Rich layout session" }, { ignorable: true });
  await turn(SESSIONS.rich, 1, TEXTS.u1, TEXTS.a1);
  await turn(SESSIONS.rich, 2, TEXTS.u2, TEXTS.a2, { reasoning: TEXTS.reasoning });
  await turn(SESSIONS.rich, 3, TEXTS.u3, TEXTS.a3);
  await turn(SESSIONS.rich, 4, TEXTS.u4, TEXTS.a4);
  await turn(SESSIONS.rich, 5, TEXTS.u5, TEXTS.a5, { tool: true });
  await turn(SESSIONS.rich, 6, TEXTS.u6, TEXTS.a6, { usage: true });
  await store.upsertProjection(projection(SESSIONS.rich, "Rich layout session", "idle"));

  // Many-rows session: MANY_TURNS user/assistant pairs — strictly more rows
  // than the 150-row suffix window, so earlier reveal and hidden prompt jumps
  // are exercised for real.
  await store.append(SESSIONS.many, "session/created", { title: "Many rows session" }, { ignorable: true });
  for (let i = 1; i <= MANY_TURNS; i++) {
    await turn(SESSIONS.many, i, `Synthetic prompt ${i} of ${MANY_TURNS}.`, `Synthetic answer ${i}: acknowledged.`);
  }
  await store.upsertProjection(projection(SESSIONS.many, "Many rows session", "idle"));

  // Empty session: created, zero messages, no phantom utilities.
  await store.append(SESSIONS.empty, "session/created", { title: "Empty layout session" }, { ignorable: true });
  await store.upsertProjection(projection(SESSIONS.empty, "Empty layout session", "idle"));

  // Stream session: settled first turn on disk; live streams run through the
  // real send path against the fake backend's `stream` behavior.
  await store.append(SESSIONS.stream, "session/created", { title: "Streaming layout session" }, { ignorable: true });
  await turn(SESSIONS.stream, 1, "Warm-up prompt before the streaming gate.", "Settled synthetic answer before any live stream.");
  await store.upsertProjection(projection(SESSIONS.stream, "Streaming layout session", "idle", { backendSessionId: "oc_tl_stream" }));

  await store.close();

  // Deterministic, distinct event times (append stamps "now"): base two hours
  // ago, 2s apart by seq, so times and durations are stable across reloads.
  const db = new DatabaseSync(join(FIXTURE_DATA, "sessions.db"));
  const base = now - 7_200_000;
  db.prepare("UPDATE events SET time = ? + seq * 2000").run(base);
  db.close();

  return {};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await buildTimelineLayoutFixture();
  console.log("TIMELINE-LAYOUT fixture ready.");
  console.log(`# project: ${PROJECT_ID}  data: ${FIXTURE_DATA}  home: ${FIXTURE_HOME}  bin: ${FIXTURE_BIN}`);
}
