// Isolated, synthetic fixture for the Usage settings live audit.
// Creates event-backed projections across 180 days so every range, trend,
// provider grouping, model breakdown, and populated chart state is testable.
//
// Usage (from the repository root):
//   node --experimental-strip-types apps/web/test/usageDashboardFixtureSetup.mjs
//   npm run build:web
//   env HOME=/tmp/polyth-usage-home-34f9 \
//     POLYTH_DATA_DIR=/tmp/polyth-usage-data-34f9 \
//     POLYTH_FAKE_QUOTAS=1 PORT=4458 npm start
//   node --test apps/web/test/usageDashboard.live.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const fixtureRoot = "/tmp/polyth-usage-fixture-34f9";
const fixtureData = "/tmp/polyth-usage-data-34f9";
const fixtureHome = "/tmp/polyth-usage-home-34f9";
const projectId = "usage-audit-project";
const sentinel = "POLYTH-USAGE-AUDIT 34f9\n";

for (const path of [fixtureRoot, fixtureData, fixtureHome]) {
  if (existsSync(path)) {
    console.error(`refusing to reuse existing path: ${path}`);
    process.exit(1);
  }
}
for (const path of [fixtureRoot, fixtureData, fixtureHome]) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(path, ".usage-audit-sentinel"), sentinel);
}

writeFileSync(
  join(fixtureRoot, "README.md"),
  "# Usage audit fixture\n\nSynthetic, disposable data for Polyth Usage settings visual verification.\n",
);
const git = (...args) => execFileSync("git", ["-C", fixtureRoot, ...args], { stdio: "pipe" });
git("init", "-b", "main");
git("config", "user.name", "Usage Audit Fixture");
git("config", "user.email", "usage-audit@example.invalid");
git("config", "commit.gpgsign", "false");
git("add", "-A");
git("commit", "-m", "chore: seed usage audit fixture");

const seedTime = Date.now();
writeFileSync(join(fixtureData, "projects.json"), JSON.stringify([{
  id: projectId,
  path: fixtureRoot,
  name: "Usage Analytics Audit",
  createdAt: seedTime,
}], null, 2));

const providers = [
  { id: "anthropic", model: "claude-sonnet-4", input: 83_000, output: 19_000, rate: 0.000015 },
  { id: "openai", model: "gpt-5", input: 71_000, output: 16_000, rate: 0.000018 },
  { id: "google", model: "gemini-2.5-pro", input: 58_000, output: 14_000, rate: 0.000010 },
  { id: "xai", model: "grok-4", input: 46_000, output: 11_000, rate: 0.000012 },
  { id: "openrouter", model: "deepseek-r1", input: 39_000, output: 9_000, rate: 0.000007 },
  { id: "opencode-go", model: "big-pickle", input: 31_000, output: 8_000, rate: 0.000006 },
  { id: "fake-provider", model: "audit-model", input: 24_000, output: 6_000, rate: 0.000008 },
];
const dayMs = 24 * 60 * 60_000;
const { createStore } = await import(join(repoRoot, "packages/session/src/index.ts"));
const store = createStore(join(fixtureData, "sessions.db"));

let sessionCount = 0;
for (let ageDays = 0; ageDays < 180; ageDays += 1) {
  // Recent buckets carry every provider. Older periods remain varied enough
  // to render honest 30/90-day trends without producing a uniform wall.
  const dailyProviders = ageDays < 14
    ? providers
    : providers.filter((_, index) => (ageDays + index * 2) % 4 !== 0);
  for (const [providerIndex, provider] of dailyProviders.entries()) {
    if ((ageDays * 3 + providerIndex) % 5 === 0 && ageDays >= 14) continue;
    sessionCount += 1;
    const id = `usage-audit-${String(sessionCount).padStart(4, "0")}`;
    const activityAt = seedTime - (ageDays + 0.18 + providerIndex * 0.07) * dayMs;
    const variation = 0.62 + ((ageDays * 11 + providerIndex * 7) % 13) / 15;
    const input = Math.round(provider.input * variation);
    const output = Math.round(provider.output * (0.72 + ((ageDays + providerIndex) % 7) / 12));
    const cost = Number(((input + output) * provider.rate).toFixed(6));
    const modelID = providerIndex % 2 === 0 && ageDays % 3 === 0
      ? `${provider.model}-thinking`
      : provider.model;
    const title = `Synthetic ${provider.id} session ${sessionCount}`;

    await store.append(id, "session/created", { title });
    await store.append(id, "turn/started", {
      turnId: `${id}-turn`,
      model: { providerID: provider.id, modelID },
      agent: "build",
    });
    await store.append(id, "usage/recorded", {
      model: { providerID: provider.id, modelID },
      tokens: { input, output },
      cost,
    });
    await store.append(id, "turn/stopped", { turnId: `${id}-turn`, reason: "completed" });
    await store.upsertProjection({
      id,
      projectId,
      title,
      status: "idle",
      model: { providerID: provider.id, modelID },
      agent: "build",
      createdAt: activityAt - 45 * 60_000,
      updatedAt: activityAt,
      lastTurnAt: activityAt,
      tokenTotals: { input, output },
      costTotal: cost,
    });
  }
}

await store.close();

console.log("Usage dashboard fixture ready.");
console.log(`export POLYTH_USAGE_URL=http://127.0.0.1:4458`);
console.log(`export POLYTH_USAGE_PROJECT_ID=${projectId}`);
console.log(`export POLYTH_USAGE_DATA=${fixtureData}`);
console.log(`export POLYTH_USAGE_HOME=${fixtureHome}`);
console.log(`export POLYTH_USAGE_ROOT=${fixtureRoot}`);
console.log(`Seeded ${sessionCount} event-backed session projections.`);
