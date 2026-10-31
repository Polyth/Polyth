// P2-W3A composer/picker fixture: isolated, synthetic, disposable.
// Seeds a rich model/agent catalog (several providers, reasoning variants,
// modality capabilities, pricing, a disconnected provider, and one bulk
// provider with 420 models plus 24 additional providers for list-scale QA)
// plus sessions covering the
// composer surfaces: a fresh project, a streaming-capable session (fake
// backend turnBehavior "work"), and a pending-permission session for the
// banner-above-composer layout. Existing fixture paths are wiped only when
// they carry the sentinel.
//
// Usage: node apps/web/test/wave3aComposerFixtureSetup.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

export const FIXTURE_ROOT = "/tmp/polyth-w3a-fixture";
export const FIXTURE_DATA = "/tmp/polyth-w3a-data";
export const FIXTURE_HOME = "/tmp/polyth-w3a-home";
export const FIXTURE_BIN = "/tmp/polyth-w3a-bin";
export const OC_SEED = join(FIXTURE_DATA, "oc-seed.json");
export const OC_STATE = join(FIXTURE_DATA, "oc-state.json");
export const OC_CATALOG = join(FIXTURE_DATA, "oc-catalog.json");
export const PROJECT_ID = "w3a-project";

export const SESSIONS = {
  stream: "w3a-stream",
  permission: "w3a-permission",
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
  writeFileSync(join(path, SENTINEL), "P2-W3A composer fixture\n");
};

const caps = (input, toolcall = true) => ({
  attachment: true,
  toolcall,
  input: Object.fromEntries(input.map((m) => [m, true])),
  output: { text: true },
});

/** GET /provider body: what a well-populated OpenCode install reports. */
const PROVIDERS = {
  all: [
    {
      id: "fable",
      name: "Fable",
      models: {
        "fable-5": {
          id: "fable-5", name: "Fable 5",
          limit: { context: 1_000_000 }, cost: { input: 3, output: 15 },
          capabilities: caps(["text", "image", "pdf"]),
          variants: { low: {}, medium: {}, high: {}, xhigh: {} },
        },
        "fable-5-mini": {
          id: "fable-5-mini", name: "Fable 5 Mini",
          limit: { context: 400_000 }, cost: { input: 0.8, output: 4 },
          capabilities: caps(["text", "image"]),
          variants: { low: {}, medium: {}, high: {} },
        },
        "fable-legacy": {
          id: "fable-legacy", name: "Fable Legacy",
          limit: { context: 128_000 }, cost: { input: 1, output: 5 },
          capabilities: caps(["text"]),
        },
      },
    },
    {
      id: "borealis",
      name: "Borealis AI",
      models: {
        "borealis-ultra": {
          id: "borealis-ultra", name: "Borealis Ultra",
          limit: { context: 2_000_000 }, cost: { input: 2.5, output: 10 },
          capabilities: caps(["text", "image", "audio", "video", "pdf"]),
          variants: { thinking: {} },
        },
        "borealis-flash": {
          id: "borealis-flash", name: "Borealis Flash",
          limit: { context: 1_000_000 }, cost: { input: 0.15, output: 0.6 },
          capabilities: caps(["text", "image"]),
        },
      },
    },
    {
      id: "synthetic",
      name: "Synthetic",
      models: {
        "fable-mini": {
          id: "fable-mini", name: "Fable Mini",
          limit: { context: 128_000 }, cost: { input: 0, output: 0 },
          capabilities: caps(["text"]),
        },
      },
    },
    {
      id: "offgrid",
      name: "Offgrid Labs",
      models: {
        "offgrid-1": {
          id: "offgrid-1", name: "Offgrid One",
          limit: { context: 200_000 }, cost: { input: 5, output: 25 },
          capabilities: caps(["text", "image"]),
          variants: { low: {}, high: {} },
        },
      },
    },
    {
      id: "openhub",
      name: "OpenHub",
      // Bulk provider: 420 models — bounded rendering + search at real scale.
      models: Object.fromEntries(Array.from({ length: 420 }, (_, i) => [
        `oh-${String(i + 1).padStart(2, "0")}`,
        {
          id: `oh-${String(i + 1).padStart(2, "0")}`,
          name: `OpenHub Community ${String(i + 1).padStart(2, "0")}${i % 7 === 0 ? " Extra Long Distillation Preview Build" : ""}`,
          limit: { context: 32_000 + (i % 5) * 32_000 },
          cost: { input: 0.05, output: 0.2 },
          capabilities: caps(["text"], i % 3 !== 0),
        },
      ])),
    },
  ],
  // offgrid stays disconnected: availability must be visible, not hidden.
  connected: ["fable", "borealis", "synthetic", "openhub"],
};

// Many-provider fixture: expansion, collapse, and search must stay responsive
// without mounting every provider's rows while groups are closed.
PROVIDERS.all.push(...Array.from({ length: 24 }, (_, providerIndex) => {
  const id = `catalog-${String(providerIndex + 1).padStart(2, "0")}`;
  return {
    id,
    name: `Catalog Provider ${String(providerIndex + 1).padStart(2, "0")}`,
    models: Object.fromEntries(Array.from({ length: 8 }, (_, modelIndex) => {
      const modelID = `model-${String(modelIndex + 1).padStart(2, "0")}`;
      return [modelID, {
        id: modelID,
        name: `Catalog ${providerIndex + 1} Model ${modelIndex + 1}`,
        limit: { context: 64_000 + modelIndex * 16_000 },
        cost: { input: 0.2, output: 0.8 },
        capabilities: caps(modelIndex % 3 === 0 ? ["text", "image"] : ["text"]),
      }];
    })),
  };
}));
PROVIDERS.connected.push(...PROVIDERS.all
  .map((provider) => provider.id)
  .filter((id) => id.startsWith("catalog-")));

/** GET /agent body: agent + purpose, primary modes only for the picker. */
const AGENTS = [
  { name: "build", description: "Writes code and runs tools to complete engineering tasks", mode: "primary" },
  { name: "plan", description: "Read-only investigation; proposes a plan before any edit", mode: "primary" },
  { name: "review", description: "Reviews diffs for correctness, style, and regressions", mode: "primary" },
  { name: "docs-writer", description: "Long-form documentation with a calm, precise voice and a very long descriptive purpose line to exercise truncation", mode: "primary" },
  { name: "summarizer", description: "Internal compaction helper", mode: "subagent" },
];

export async function buildWave3aComposerFixture() {
  for (const p of [FIXTURE_ROOT, FIXTURE_DATA, FIXTURE_HOME, FIXTURE_BIN]) resetDir(p);

  // --- synthetic project repository ------------------------------------------
  writeFileSync(join(FIXTURE_ROOT, "README.md"), "# P2-W3A synthetic composer fixture\n\nDisposable repository for composer/picker QA.\n");
  mkdirSync(join(FIXTURE_ROOT, "docs"), { recursive: true });
  writeFileSync(join(FIXTURE_ROOT, "docs/notes.md"), "Synthetic attachment target.\n");
  const git = (...args) => execFileSync("git", ["-C", FIXTURE_ROOT, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "W3A Composer Fixture Bot");
  git("config", "user.email", "w3a-fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-m", "chore: seed synthetic w3a composer fixture");

  // --- fake backend binary on PATH -------------------------------------------
  const fake = join(here, "msgActionsFakeBackend.mjs");
  const wrapper = join(FIXTURE_BIN, "opencode");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(wrapper, 0o755);

  writeFileSync(OC_CATALOG, JSON.stringify({ providers: PROVIDERS, agents: AGENTS }, null, 2));
  writeFileSync(OC_SEED, JSON.stringify({
    sessions: [
      {
        id: "oc_w3a_work",
        title: "W3A streaming work session",
        turnBehavior: "work",
        messages: [
          { id: "w3a_u0", role: "user", text: "Warm-up prompt before streaming QA." },
          { id: "w3a_a0", role: "assistant", text: "Settled synthetic answer before any live stream." },
        ],
      },
    ],
  }, null, 2));

  // --- isolated Polyth data ----------------------------------------------------
  writeFileSync(join(FIXTURE_DATA, "projects.json"), JSON.stringify([{
    id: PROJECT_ID,
    path: FIXTURE_ROOT,
    name: "W3A Composer Fixture",
    createdAt: Date.now(),
  }], null, 2));

  const { createStore } = await import(join(REPO_ROOT, "packages/session/src/index.ts"));
  const store = createStore(join(FIXTURE_DATA, "sessions.db"));
  const now = Date.now();

  const projection = (id, title, status, extra = {}) => ({
    id, projectId: PROJECT_ID, title, status,
    createdAt: now - 7_200_000, updatedAt: now, ...extra,
  });
  const MODEL = { providerID: "fable", modelID: "fable-5" };

  // ---- w3a-stream: live streaming against the fake backend --------------------
  {
    const id = SESSIONS.stream;
    await store.append(id, "session/created", { title: "W3A streaming work session" }, { ignorable: true });
    await store.append(id, "user/message", { text: "Warm-up prompt before streaming QA." });
    await store.append(id, "turn/started", { turnId: `${id}-t1`, model: MODEL, agent: "build" }, { ignorable: true });
    await store.append(id, "assistant/message", { partId: `${id}-p1`, text: "Settled synthetic answer before any live stream." });
    await store.append(id, "usage/recorded", { model: MODEL, tokens: { input: 84_000, output: 1_400 }, cost: 0.3 }, { ignorable: true });
    await store.append(id, "turn/stopped", { turnId: `${id}-t1`, reason: "completed" }, { ignorable: true });
    await store.upsertProjection(projection(id, "W3A streaming work session", "idle", { backendSessionId: "oc_w3a_work" }));
  }

  // ---- w3a-permission: pending approval directly above the composer -----------
  {
    const id = SESSIONS.permission;
    await store.append(id, "session/created", { title: "Approvals pending" }, { ignorable: true });
    await store.append(id, "user/message", { text: "Clean the build artifacts." });
    await store.append(id, "turn/started", { turnId: `${id}-t1`, model: MODEL, agent: "build" }, { ignorable: true });
    await store.append(id, "assistant/message", { partId: `${id}-p0`, text: "I need an approval before continuing." });
    await store.append(id, "permission/requested", {
      requestId: `${id}-perm-1`,
      permission: "bash",
      tool: "Shell",
      patterns: ["rm -rf apps/web/dist"],
      preview: { title: "Delete build artifacts", lines: ["rm -rf apps/web/dist", "cwd: /workspace"], risk: "medium" },
      allowedScopes: ["once", "session", "project"],
    });
    await store.upsertProjection(projection(id, "Approvals pending", "waiting"));
  }

  await store.close();

  const db = new DatabaseSync(join(FIXTURE_DATA, "sessions.db"));
  db.prepare("UPDATE events SET time = ? + seq * 2000").run(now - 7_200_000);
  db.close();

  return {};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await buildWave3aComposerFixture();
  console.log("P2-W3A composer fixture ready.");
  console.log(`# project: ${PROJECT_ID}  data: ${FIXTURE_DATA}  home: ${FIXTURE_HOME}  bin: ${FIXTURE_BIN}`);
  console.log("# start:");
  console.log(`#   HOME=${FIXTURE_HOME} POLYTH_DATA_DIR=${FIXTURE_DATA} PORT=4473 PATH=${FIXTURE_BIN}:$PATH \\`);
  console.log(`#   MSGACT_OC_SEED=${OC_SEED} MSGACT_OC_STATE=${OC_STATE} MSGACT_OC_CATALOG=${OC_CATALOG} \\`);
  console.log("#   node packages/server/src/index.ts");
}
