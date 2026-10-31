import assert from "node:assert/strict";
import test from "node:test";

import type { HarnessSnapshot } from "@polyth/contracts";
import { availabilityLabel, configurationSections, displayVersion, HARNESS_COLORS, harnessDisplayName, harnessProfileName, harnessSummary, harnessTint, needsReadinessCheck, statusTone } from "../widgets/presentation.ts";

test("harness display names keep known brands readable and format unknown ids", () => {
  assert.equal(harnessDisplayName("claude"), "Claude");
  assert.equal(harnessDisplayName("codex"), "Codex");
  assert.equal(harnessDisplayName("open-code"), "Open Code");
  assert.equal(harnessDisplayName("custom_harness"), "Custom Harness");
  assert.equal(harnessDisplayName(""), "");
});

test("an extra harness login keeps its label and its own color without a badge", () => {
  assert.equal(harnessProfileName({ name: "Claude Code", accountLabel: "ines" }), "Claude Code · ines");
  assert.equal(harnessProfileName({ name: "Claude Code · ines", accountLabel: "ines" }), "Claude Code · ines");
  assert.equal(harnessProfileName({ name: "Ines", accountLabel: "ines" }), "Ines");
  assert.equal(harnessProfileName({ name: "Claude Code" }), "Claude Code");
  const color = (identity: Parameters<typeof harnessTint>[0]) => (harnessTint(identity) as Record<string, string> | undefined)?.["--pkg-harness-color"];
  const derived = color({ accountLabel: "ines" });
  assert.equal(color({ accountLabel: " ines " }), derived);
  assert.ok((HARNESS_COLORS as readonly string[]).includes(derived!));
  assert.equal(color({ color: "#123456", accountLabel: "ines" }), "#123456");
  assert.equal(color({}), undefined);
});

test("shared harness detail sections appear for every harness without leaking harness-specific sections", () => {
  const items = [
    { id: "system", order: 5, meta: { harnessId: "*", sectionId: "system-prompt", label: "System prompt" } },
    { id: "claude-runtime", order: 20, meta: { harnessId: "claude", sectionId: "runtime", label: "Runtime" } },
    { id: "codex-runtime", order: 20, meta: { harnessId: "codex", sectionId: "runtime", label: "Runtime" } },
  ];

  assert.deepEqual(configurationSections(items, "claude").map((section) => section.id), ["system-prompt", "runtime"]);
  assert.deepEqual(configurationSections(items, "codex").map((section) => section.id), ["system-prompt", "runtime"]);
  assert.deepEqual(configurationSections(items, "pi").map((section) => section.id), ["system-prompt"]);
});

test("a shared section and a harness's own contribution to the same id are one tab", () => {
  const items = [
    { id: "harnesses.maintenance", order: 4, meta: { harnessId: "*", sectionId: "runtime", label: "Runtime" } },
    { id: "opencode.roles", order: 20, meta: { harnessId: "opencode", sectionId: "roles", label: "Roles" } },
    { id: "opencode.runtime", order: 80, meta: { harnessId: "opencode", sectionId: "runtime", label: "Runtime", handlesPendingChanges: true } },
  ];
  assert.deepEqual(configurationSections(items, "opencode"), [
    { id: "runtime", label: "Runtime", order: 4, handlesPendingChanges: true },
    { id: "roles", label: "Roles", order: 20 },
  ]);
  assert.deepEqual(configurationSections(items, "claude"), [{ id: "runtime", label: "Runtime", order: 4 }]);
});

test("the shared Accounts section appears only on multi-account harness families", () => {
  const items = [
    { id: "system", order: 5, meta: { harnessId: "*", sectionId: "system-prompt", label: "System prompt" } },
    { id: "accounts", order: 3, meta: { harnessId: "*", sectionId: "accounts", label: "Accounts", requires: "accounts" } },
  ];
  const accounts = { family: "codex", endpoint: "/api/backend-codex/accounts" };
  assert.deepEqual(configurationSections(items, "codex", { accounts }).map((section) => section.id), ["accounts", "system-prompt"]);
  assert.deepEqual(configurationSections(items, "codex-work", { accounts }).map((section) => section.id), ["accounts", "system-prompt"]);
  assert.deepEqual(configurationSections(items, "opencode", {}).map((section) => section.id), ["system-prompt"]);
  assert.deepEqual(configurationSections(items, "opencode").map((section) => section.id), ["system-prompt"]);
});

test("an account harness without a live descriptor keeps its family brand", () => {
  assert.equal(harnessDisplayName("codex-work"), "Codex · Work");
  assert.equal(harnessDisplayName("commandcode-client-2"), "Command Code · Client 2");
  assert.equal(harnessDisplayName("open-code"), "Open Code");
});

const snapshot = (id: string, availability: Partial<HarnessSnapshot["availability"]>, extra: Partial<HarnessSnapshot> = {}): HarnessSnapshot => ({
  identity: { id, name: id, integration: "test" },
  policy: { enabled: true, priority: 0, autoSelect: true },
  availability: { harnessId: id, state: "ready", installed: true, healthy: true, authenticated: true, checkedAt: 1, ...availability },
  context: { spaceId: "s", projectId: "p", cwd: "/", revision: "r", fetchedAt: 1 },
  ...extra,
});

test("only a state someone can act on needs attention; unverified and checking rows never do", () => {
  const rows = [
    snapshot("ready", {}),
    snapshot("unknown", { state: "unknown", authenticated: "unknown" }),
    snapshot("checking", { state: "unknown", authenticated: "unknown" }),
    snapshot("signed-out", { state: "auth-required", authenticated: false }),
    snapshot("degraded", { state: "degraded" }),
    snapshot("missing", { state: "not-installed", installed: false, healthy: false }),
    snapshot("off", {}, { policy: { enabled: false, priority: 0, autoSelect: true } }),
  ];
  assert.deepEqual(harnessSummary(rows, { checking: new Set(["checking"]), updates: new Set(["ready", "missing"]) }), {
    ready: 1, attention: 2, signIn: 1, off: 1, missing: 1, checking: 1, unverified: 1, updates: 1,
  });
  assert.equal(availabilityLabel(rows[1]!), "Not verified");
  assert.equal(availabilityLabel(rows[2]!, { checking: true }), "Checking…");
  assert.equal(statusTone(rows[1]!), "neutral");
});

test("a kept row reads as its state, and only a failed check says last known", () => {
  assert.equal(availabilityLabel(snapshot("cached", {}, { stale: true })), "Ready");
  assert.equal(statusTone(snapshot("cached", {}, { stale: true })), "success");
  assert.equal(availabilityLabel(snapshot("outage", { state: "degraded" }, { stale: true })), "Degraded · Last known");
});

test("Settings checks natively only an enabled, installed harness whose probe cannot see sign-in", () => {
  assert.equal(needsReadinessCheck(snapshot("unknown", { state: "unknown", authenticated: "unknown" })), true);
  assert.equal(needsReadinessCheck(snapshot("ready", {})), false);
  assert.equal(needsReadinessCheck(snapshot("signed-out", { state: "unknown", authenticated: false })), false);
  assert.equal(needsReadinessCheck(snapshot("missing", { state: "unknown", installed: false })), false);
  assert.equal(needsReadinessCheck(snapshot("off", { state: "unknown", authenticated: "unknown" }, { policy: { enabled: false, priority: 0, autoSelect: true } })), false);
});

test("version text keeps the comparable token and drops a build hash", () => {
  assert.equal(displayVersion("codex-cli 0.160.0"), "0.160.0");
  assert.equal(displayVersion("opencode v2.0.29"), "2.0.29");
  assert.equal(displayVersion("2.1.300 (Claude Code)"), "2.1.300");
  assert.equal(displayVersion("2026.09.15-d2fe57e"), "2026.09.15");
  assert.equal(displayVersion("1.3.0-beta.2"), "1.3.0-beta.2");
  assert.equal(displayVersion("omp/18.1.20"), "18.1.20");
  assert.equal(displayVersion("nightly"), "nightly");
  assert.equal(displayVersion(undefined), undefined);
});

test("a harness's own section can replace a shared one", () => {
  const items = [
    { id: "models", order: 2, meta: { harnessId: "*", sectionId: "models", label: "Models" } },
    { id: "opencode-models", order: 2, meta: { harnessId: "opencode", sectionId: "providers-models", label: "Providers & Models", replaces: ["models"] } },
  ];
  assert.deepEqual(configurationSections(items, "opencode").map((section) => section.id), ["providers-models"]);
  assert.deepEqual(configurationSections(items, "codex").map((section) => section.id), ["models"]);
});
