import assert from "node:assert/strict";
import test from "node:test";
import type { ModelDescriptor } from "@polyth/contracts";
import type { UsageObservation } from "../src/analytics/contracts.ts";
import type { UsageLimitSnapshot } from "../src/limits.ts";
import { buildModelRouting, parseFavoriteKey } from "../src/routing.ts";

type Candidate = ReturnType<typeof buildModelRouting>["candidates"][number];

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let seq = 0;
const observation = (
  harnessId: string,
  providerId: string,
  modelId: string,
  at = NOW - HOUR,
  extra: Partial<UsageObservation> = {},
): UsageObservation => ({
  id: `o${++seq}`,
  timestamp: at,
  projectId: "p",
  sessionId: extra.sessionId ?? `s-${harnessId}-${modelId}`,
  providerId,
  modelId,
  harnessId,
  tokens: { input: 1, output: 1, reasoning: null, cacheRead: null, cacheWrite: null },
  status: "completed",
  quality: "exact",
  ...extra,
});

const snapshot = (providerId: string, windows: Array<[string, number, number?]>, extra: Partial<UsageLimitSnapshot> = {}): UsageLimitSnapshot => ({
  providerId,
  windows: windows.map(([id, used, resetsAt]) => ({
    id, label: id, used, limit: 100, unit: "percent", ...(resetsAt ? { resetsAt } : {}),
  })),
  fetchedAt: NOW - 60_000,
  stale: false,
  balances: [],
  pace: {},
  ...extra,
});

const row = (harnessId: string, providerID: string, modelID: string, resolvedModelID?: string): ModelDescriptor => ({
  harnessId, providerID, modelID, name: modelID, ...(resolvedModelID ? { resolvedModelID } : {}),
});

/** Rows as Claude Code 2.1.294 lists them: aliases with what they resolve to,
 *  then pinned releases. */
const claudeCatalog = (harnessId = "claude"): ModelDescriptor[] => [
  row(harnessId, "anthropic", "default", "claude-opus-5-5"),
  row(harnessId, "anthropic", "opus", "claude-opus-5-5"),
  row(harnessId, "anthropic", "fable", "claude-fable-5-1"),
  row(harnessId, "anthropic", "sonnet", "claude-sonnet-5-5"),
  row(harnessId, "anthropic", "claude-opus-4-8"),
];

test("favorite keys keep slashes inside the model id", () => {
  assert.deepEqual(parseFavoriteKey("pi::commandcode/deepseek/deepseek-v4.1-flash"), {
    harnessId: "pi", providerID: "commandcode", modelID: "deepseek/deepseek-v4.1-flash",
  });
  assert.deepEqual(parseFavoriteKey("anthropic/opus"), { harnessId: "opencode", providerID: "anthropic", modelID: "opus" });
  assert.equal(parseFavoriteKey("claude::opus"), undefined);
});

test("ranks usable favorites first, then most-used, and pushes blocked or missing harnesses last", () => {
  const report = buildModelRouting({
    now: NOW,
    observations: [
      ...Array.from({ length: 5 }, () => observation("codex", "openai", "gpt-5.5")),
      observation("claude", "anthropic", "opus"),
      observation("claude", "anthropic", "opus", NOW - HOUR, { status: "failed" }),
      observation("grok", "xai", "grok-5"),
      // Outside the 30-day window.
      ...Array.from({ length: 9 }, () => observation("pi", "x", "old", NOW - 40 * DAY)),
    ],
    favorites: ["claude::anthropic/opus", "antigravity::antigravity/gemini-3.8-flash", "cursor::cursor/grok-4.7"],
    snapshots: [
      snapshot("claude", [["5h", 7, NOW + 2 * HOUR], ["7d", 51, NOW + 3 * DAY], ["fable/7d", 100, NOW + DAY]]),
      snapshot("antigravity", [["google-weekly", 36], ["third-party-5h", 100, NOW + 3 * HOUR]]),
      snapshot("codex", [["30d", 100, NOW + 5 * DAY]]),
    ],
    available: (harnessId) => harnessId !== "cursor",
  });

  assert.deepEqual(report.candidates.map((c) => `${c.harnessId}:${c.modelID}`), [
    "claude:opus",
    "antigravity:gemini-3.8-flash",
    "grok:grok-5",
    // Unusable rows keep the favorite-first order among themselves.
    "cursor:grok-4.7",
    "codex:gpt-5.5",
  ]);
  const [claude, gemini, , cursor, codex] = report.candidates as [Candidate, Candidate, Candidate, Candidate, Candidate];
  // The Fable-only window does not constrain Opus.
  assert.equal(claude.quotaUsed, 0.51);
  assert.equal(claude.blocked, false);
  assert.equal(claude.failed, 1);
  // Antigravity's third-party window does not constrain a Gemini model.
  assert.equal(gemini.quotaUsed, 0.36);
  assert.equal(gemini.blocked, false);
  assert.equal(codex.blocked, true);
  assert.equal(codex.blockedUntil, NOW + 5 * DAY);
  assert.equal(cursor.available, false);
  assert.ok(!report.candidates.some((c) => c.modelID === "old"));

  assert.match(report.text, /^1\. ★ claude anthropic\/opus · 2t\/1s 50% fail last 1h ago · quota 51%$/m);
  assert.match(report.text, /codex openai\/gpt-5\.5 · 5t\/1s .*BLOCKED ~5d/);
  assert.match(report.text, /cursor cursor\/grok-4\.7 · unused · UNAVAILABLE/);
  assert.match(report.text, /^- claude: 5h 7% ↻2h, 7d 51% ↻3d, fable\/7d 100% ↻24h$/m);
});

test("a reset that already passed does not block, and limit/harness filters bound the output", () => {
  const report = buildModelRouting({
    now: NOW,
    observations: [observation("claude", "anthropic", "sonnet"), observation("codex", "openai", "gpt-5.5")],
    favorites: [],
    snapshots: [snapshot("claude", [["5h", 100, NOW - 1]]), snapshot("codex", [["30d", 10]])],
    available: () => true,
    harnessId: "claude",
    limit: 1,
  });
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0]!.blocked, false);
  assert.equal(report.candidates[0]!.quotaUsed, undefined);
  assert.deepEqual(report.quotas.map((quota) => quota.sourceId), ["claude"]);
});

test("provider-billed quotas apply across harnesses; dashed source ids match their harness", () => {
  const report = buildModelRouting({
    now: NOW,
    observations: [
      observation("opencode", "github-copilot", "gpt-5.5"),
      observation("commandcode", "deepseek", "deepseek-v4"),
    ],
    favorites: [],
    snapshots: [
      snapshot("github-copilot", [["premium", 98]]),
      snapshot("command-code", [["5h", 4], ["weekly", 7]]),
    ],
    available: () => true,
  });
  const byHarness = Object.fromEntries(report.candidates.map((c) => [c.harnessId, c.quotaUsed]));
  assert.deepEqual(byHarness, { opencode: 0.98, commandcode: 0.07 });
});

test("an empty Space says how to proceed instead of returning nothing", () => {
  const report = buildModelRouting({ now: NOW, observations: [], favorites: [], snapshots: [], available: () => true });
  assert.equal(report.candidates.length, 0);
  assert.match(report.text, /Polyth Auto/);
});

test("an account harness is metered by its own source only, never the family default", () => {
  const report = buildModelRouting({
    now: NOW,
    observations: [observation("claude", "anthropic", "opus"), observation("claude-work", "anthropic", "opus")],
    favorites: [],
    snapshots: [
      snapshot("claude", [["5h", 100, NOW + HOUR]]),
      snapshot("claude-work", [["5h", 20]], { account: { family: "claude", harnessId: "claude-work", label: "Work" } }),
    ],
    available: () => true,
  });
  const byHarness = Object.fromEntries(report.candidates.map((c) => [c.harnessId, [c.quotaUsed, c.blocked]]));
  assert.deepEqual(byHarness, { "claude-work": [0.2, false], claude: [1, true] });
  // The usable account is ranked ahead of the exhausted default login.
  assert.equal(report.candidates[0]!.harnessId, "claude-work");
});

test("pairs are named as the live catalog names them: the alias a spawn takes, not the id telemetry reported", () => {
  const report = buildModelRouting({
    now: NOW,
    observations: [
      ...Array.from({ length: 3 }, () => observation("claude", "anthropic", "claude-opus-5-5")),
      observation("claude", "anthropic", "claude-opus-5-5", NOW - HOUR, { status: "failed", sessionId: "s-other" }),
      observation("claude", "anthropic", "claude-sonnet-5-5"),
      observation("claude", "anthropic", "claude-opus-4-8"),
      observation("claude-work", "anthropic", "claude-opus-5-5"),
    ],
    // The picker stars catalog rows, so the favorite and the reported id are one model.
    favorites: ["claude::anthropic/opus"],
    catalog: [...claudeCatalog(), ...claudeCatalog("claude-work")],
    snapshots: [],
    available: () => true,
  });

  assert.deepEqual(report.candidates.map((c) => `${c.harnessId}:${c.modelID}`), [
    "claude:opus",
    "claude:sonnet",
    "claude:claude-opus-4-8",
    "claude-work:opus",
  ]);
  const [opus, sonnet, pinned] = report.candidates as [Candidate, Candidate, Candidate];
  assert.deepEqual(
    [opus.favorite, opus.turns, opus.sessions, opus.failed, opus.listed, opus.runs],
    [true, 4, 2, 1, true, "Claude Opus 5.5"],
  );
  assert.equal(sonnet.runs, "Claude Sonnet 5.5");
  // A pinned release is its own concrete row.
  assert.deepEqual([pinned.listed, pinned.runs], [true, undefined]);
  assert.equal(report.unlisted, 0);
  assert.equal(report.catalogUnavailable, undefined);
  assert.match(report.text, /^1\. ★ claude anthropic\/opus \(Claude Opus 5\.5\) · 4t\/2s 25% fail last 1h ago$/m);
  assert.match(report.text, /live catalog names them/);
  assert.doesNotMatch(report.text, /anthropic\/claude-opus-5-5/);
});

test("an alias that names the model wins over the account default, unless the user starred another", () => {
  const run = (favorites: string[]) => buildModelRouting({
    now: NOW,
    observations: [observation("claude", "anthropic", "claude-opus-5-5")],
    favorites,
    catalog: claudeCatalog(),
    snapshots: [],
    available: () => true,
  });
  assert.deepEqual(run([]).candidates.map((c) => [c.modelID, c.favorite, c.turns]), [["opus", false, 1]]);
  assert.deepEqual(
    run(["claude::anthropic/default"]).candidates.map((c) => [c.modelID, c.favorite, c.turns, c.runs]),
    [["default", true, 1, "Claude Opus 5.5"]],
  );
});

test("models a harness no longer offers are left out and counted, favorites included", () => {
  const report = buildModelRouting({
    now: NOW,
    observations: [
      // Gone from the account's plan.
      ...Array.from({ length: 4 }, () => observation("codex", "openai", "gpt-6-sol")),
      observation("codex", "openai", "gpt-5.6-luna"),
      // Not a model at all.
      observation("opencode", "opencode", "unknown"),
      observation("claude", "anthropic", "<synthetic>"),
    ],
    favorites: ["codex::openai/gpt-6-astra", "codex::openai/gpt-6-luna"],
    catalog: [
      row("codex", "openai", "gpt-5.6-luna"),
      row("codex", "openai", "gpt-6-luna"),
      row("opencode", "opencode", "space-bunny-free"),
      ...claudeCatalog(),
    ],
    snapshots: [],
    available: () => true,
  });
  assert.deepEqual(report.candidates.map((c) => `${c.harnessId}:${c.modelID}`), ["codex:gpt-6-luna", "codex:gpt-5.6-luna"]);
  assert.equal(report.unlisted, 4);
  assert.match(report.text, /^\(4 used or starred models are no longer offered by their harnesses; left out\)$/m);
});

test("a harness the catalog does not cover keeps its pairs, marked unverified", () => {
  const report = buildModelRouting({
    now: NOW,
    observations: [
      observation("grok", "xai", "grok-5"),
      observation("codex", "openai", "gpt-5.6-luna"),
      observation("cursor", "cursor", "composer-3"),
    ],
    favorites: [],
    catalog: [row("codex", "openai", "gpt-5.6-luna")],
    snapshots: [],
    available: (harnessId) => harnessId !== "cursor",
  });
  const byHarness = Object.fromEntries(report.candidates.map((c) => [c.harnessId, c.listed]));
  assert.deepEqual(byHarness, { grok: false, codex: true, cursor: false });
  assert.match(report.text, /grok xai\/grok-5 · 1t\/1s last 1h ago · model unverified: no live catalog$/m);
  // An unavailable harness already says why it cannot be used.
  assert.match(report.text, /cursor cursor\/composer-3 · 1t\/1s last 1h ago · UNAVAILABLE: harness not running$/m);
  assert.equal(report.unlisted, 0);
});

test("without any live catalog the ids pass through and the shortlist says so once", () => {
  const report = buildModelRouting({
    now: NOW,
    observations: [observation("claude", "anthropic", "claude-opus-5-5"), observation("codex", "openai", "gpt-5.5")],
    favorites: [],
    catalog: [],
    snapshots: [],
    available: () => true,
  });
  assert.equal(report.catalogUnavailable, true);
  assert.deepEqual(report.candidates.map((c) => [c.modelID, c.listed]), [["claude-opus-5-5", false], ["gpt-5.5", false]]);
  assert.match(report.text, /^\(no live model catalog could be read: model ids below are unverified\)$/m);
  assert.doesNotMatch(report.text, /model unverified: no live catalog|live catalog names them/);
});

test("a provider id spelled differently by telemetry still finds its catalog row", () => {
  const report = buildModelRouting({
    now: NOW,
    observations: [observation("opencode", "github-copilot", "gpt-5.5")],
    favorites: [],
    catalog: [row("opencode", "github-copilot-addon", "gpt-5.5")],
    snapshots: [],
    available: () => true,
  });
  assert.deepEqual(report.candidates.map((c) => `${c.providerID}/${c.modelID}`), ["github-copilot-addon/gpt-5.5"]);
});

test("model-scoped quota windows follow what an alias runs", () => {
  const report = buildModelRouting({
    now: NOW,
    observations: [],
    favorites: ["claude::anthropic/default", "claude::anthropic/opus"],
    catalog: [row("claude", "anthropic", "default", "claude-fable-5-1"), row("claude", "anthropic", "opus", "claude-opus-5-5")],
    snapshots: [snapshot("claude", [["fable/7d", 100, NOW + DAY], ["5h", 10, NOW + HOUR]])],
    available: () => true,
  });
  const byModel = Object.fromEntries(report.candidates.map((c) => [c.modelID, [c.blocked, c.blockedUntil, c.quotaUsed]]));
  // `default` runs Fable today, so the Fable-only window meters it.
  assert.deepEqual(byModel, { opus: [false, undefined, 0.1], default: [true, NOW + DAY, 1] });
});

test("an id that spells out a row's variant names that row, so an older effort-suffixed id is not called retired", () => {
  const report = buildModelRouting({
    now: NOW,
    observations: [
      observation("antigravity", "antigravity", "gemini-3.8-flash-high"),
      observation("antigravity", "antigravity", "gemini-3.8-flash"),
    ],
    favorites: ["antigravity::antigravity/gemini-3.8-flash-low", "antigravity::antigravity/gemini-3.8-flash-ultra"],
    catalog: [{
      harnessId: "antigravity", providerID: "antigravity", modelID: "gemini-3.8-flash", name: "Gemini 3.8 Flash",
      variants: ["low", "medium", "high"], defaultVariant: "high",
    }],
    snapshots: [],
    available: () => true,
  });
  assert.deepEqual(
    report.candidates.map((c) => [c.modelID, c.favorite, c.turns]),
    [["gemini-3.8-flash", true, 2]],
  );
  // `ultra` is not an advertised variant.
  assert.equal(report.unlisted, 1);
});

test("an explicit allow-list ranks exactly its pairs, used or not, with their headroom", () => {
  const report = buildModelRouting({
    now: NOW,
    observations: [
      ...Array.from({ length: 4 }, () => observation("claude", "anthropic", "claude-opus-5-5")),
      observation("grok", "xai", "grok-5"),
    ],
    favorites: ["grok::xai/grok-5"],
    snapshots: [snapshot("claude", [["5h", 100, NOW + 2 * HOUR]]), snapshot("codex", [["5h", 30, NOW + HOUR]])],
    catalog: [...claudeCatalog(), row("codex", "openai", "gpt-5.5")],
    available: () => true,
    // A judge's allowed models: a never-used Codex model and the Claude alias.
    pairs: ["codex::openai/gpt-5.5", "claude::anthropic/opus", "codex::openai/retired"],
  });
  assert.deepEqual(report.candidates.map((c) => `${c.harnessId}:${c.modelID}`), ["codex:gpt-5.5", "claude:opus"],
    "only the allowed pairs, usable first; the starred Grok is not on the list and the retired id is dropped");
  const [codex, claude] = report.candidates as [Candidate, Candidate];
  assert.equal(codex.turns, 0); assert.equal(codex.quotaUsed, 0.3); assert.equal(codex.blocked, false);
  assert.equal(claude.turns, 4, "telemetry for what the alias runs still counts");
  assert.equal(claude.blocked, true); assert.equal(claude.blockedUntil, NOW + 2 * HOUR);
  assert.equal(report.unlisted, 1);
  assert.deepEqual(report.quotas.map((quota) => quota.sourceId).sort(), ["claude", "codex"]);
});

test("an Antigravity account's third-party window does not block its Gemini models", () => {
  const report = buildModelRouting({
    now: NOW,
    observations: [observation("antigravity-ines", "antigravity", "gemini-3.8-flash")],
    favorites: [],
    snapshots: [
      snapshot("antigravity", [["google-weekly", 90]]),
      snapshot("antigravity-ines", [["google-weekly", 20], ["third-party-5h", 100, NOW + 3 * HOUR]], {
        account: { family: "antigravity", harnessId: "antigravity-ines", label: "Ines" },
      }),
    ],
    available: () => true,
  });
  const [gemini] = report.candidates as [Candidate];
  // The account's own windows meter it; the default login's 90% does not.
  assert.equal(gemini.quotaUsed, 0.2);
  assert.equal(gemini.blocked, false);
});
