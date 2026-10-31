import test from "node:test";
import assert from "node:assert/strict";
import {
  dedupeHandoffSources,
  visibleHandoffSources,
} from "../widgets/lib/sources.ts";
import {
  deriveSessionTargetLabel,
  dockPasteTargetName,
  formatTokenEstimate,
} from "../widgets/lib/format.ts";

test("formatTokenEstimate uses approximation prefix", () => {
  assert.equal(formatTokenEstimate(480), "≈480");
  assert.equal(formatTokenEstimate(999), "≈999");
  assert.equal(formatTokenEstimate(1200), "≈1.2k");
});

test("dedupeHandoffSources removes duplicate ids", () => {
  const rows = dedupeHandoffSources([
    { id: "task", label: "Task", description: "a", tokens: 100 },
    { id: "task", label: "Task duplicate", description: "b", tokens: 200 },
    { id: "git-diff", label: "Git diff", description: "c", tokens: 300 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.label, "Task");
});

test("deriveSessionTargetLabel never stringifies objects", () => {
  const label = deriveSessionTargetLabel({
    id: "s1",
    projectId: "p1",
    title: "Session",
    status: "working",
    createdAt: 1,
    updatedAt: 1,
    resolvedHarnessId: "opencode",
    model: { providerID: "openai", modelID: "gpt-5.6" },
  }, "OpenCode", [{
    providerID: "openai",
    modelID: "gpt-5.6",
    name: "GPT-5.6",
    connected: true,
  }]);
  assert.match(label ?? "", /OpenCode/);
  assert.match(label ?? "", /GPT-5\.6/);
  assert.doesNotMatch(label ?? "", /\[object Object\]/);
});

test("dockPasteTargetName uses custom tab title", () => {
  assert.equal(dockPasteTargetName({
    providerId: "custom",
    providerName: "Custom chat",
    tabTitle: "Test chat",
  }), "Test chat");
  assert.equal(dockPasteTargetName({
    providerId: "chatgpt",
    providerName: "ChatGPT",
    tabTitle: "Ignored",
  }), "ChatGPT");
});

test("visibleHandoffSources filters to preset ids", () => {
  const rows = visibleHandoffSources([
    { id: "task", label: "Task", description: "", tokens: 1 },
    { id: "git-diff", label: "Git diff", description: "", tokens: 2 },
    { id: "note", label: "Custom note", description: "", tokens: 3 },
  ], ["task", "git-diff"]);
  assert.deepEqual(rows.map((row) => row.id), ["task", "git-diff"]);
});
