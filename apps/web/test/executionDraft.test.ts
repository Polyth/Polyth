import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearDraftExecutionConfig,
  newChatDraftRoute,
  preferredVisibleHarness,
  readDraftExecutionConfig,
  updateDraftExecutionConfig,
} from "../src/executionDraft.ts";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  },
});

test("new-conversation execution browsing remains one browser-local harness-qualified draft", () => {
  clearDraftExecutionConfig("project-a");
  updateDraftExecutionConfig("project-a", {
    harnessSelection: { mode: "pinned", harnessId: "codex" },
    harnessSelectionExplicit: true,
    model: { harnessId: "codex", providerID: "openai", modelID: "gpt-5" },
  });
  updateDraftExecutionConfig("project-a", {
    harnessSelection: { mode: "pinned", harnessId: "opencode" },
    model: { harnessId: "opencode", providerID: "openrouter", modelID: "claude" },
    agent: { harnessId: "opencode", agent: "build" },
    thinking: "high",
  });
  assert.deepEqual(readDraftExecutionConfig("project-a"), {
    harnessSelection: { mode: "pinned", harnessId: "opencode" },
    harnessSelectionExplicit: true,
    model: { harnessId: "opencode", providerID: "openrouter", modelID: "claude" },
    agent: { harnessId: "opencode", agent: "build" },
    thinking: "high",
  });
  assert.equal(values.size, 1, "browsing only writes the project draft; it has no session persistence seam");
});

test("invalid stored execution identities degrade to Auto instead of crossing harnesses", () => {
  values.set("polyth.executionDraft.v1.project-b", JSON.stringify({
    harnessSelection: { mode: "pinned", harnessId: "../bad" },
    model: { providerID: "openai", modelID: "gpt-5" },
  }));
  assert.deepEqual(readDraftExecutionConfig("project-b"), { harnessSelection: { mode: "auto" } });
});

test("a new chat drops remembered picks and project defaults the caller's roster hides", () => {
  const visible = new Set(["claude", "opencode"]);
  const draft = {
    harnessSelection: { mode: "pinned" as const, harnessId: "codex" },
    harnessSelectionExplicit: true,
    model: { harnessId: "codex", providerID: "openai", modelID: "gpt-5" },
    agent: { harnessId: "opencode", agent: "build" },
    thinking: "high",
  };
  const hidden = newChatDraftRoute(draft, { mode: "pinned", harnessId: "cursor" }, visible);
  assert.deepEqual(hidden, {
    draft: {
      harnessSelection: { mode: "auto" },
      agent: { harnessId: "opencode", agent: "build" },
      thinking: "high",
    },
    hidden: true,
  });
  // A visible project default stays the default once a hidden pick is dropped.
  assert.deepEqual(
    newChatDraftRoute(draft, { mode: "pinned", harnessId: "claude" }, visible).projectHarness,
    { mode: "pinned", harnessId: "claude" },
  );
  // Visible routes and an unknown roster keep everything as it was.
  const usable = { ...draft, harnessSelection: { mode: "pinned" as const, harnessId: "opencode" }, model: { harnessId: "opencode", providerID: "x", modelID: "y" } };
  assert.deepEqual(newChatDraftRoute(usable, { mode: "auto" }, visible), { draft: usable, projectHarness: { mode: "auto" }, hidden: false });
  assert.deepEqual(newChatDraftRoute(draft, null, undefined), { draft, hidden: false });
});

test("the fallback harness follows favorites, then recents, among the caller's harnesses", () => {
  const visible = new Set(["claude", "opencode"]);
  const prefs = { favorites: ["codex::openai/gpt-5", "opencode::x/y"], recents: ["claude::anthropic/opus"] };
  assert.equal(preferredVisibleHarness(prefs, visible), "opencode");
  assert.equal(preferredVisibleHarness({ favorites: ["codex::openai/gpt-5", "anthropic/opus"], recents: ["claude::anthropic/opus"] }, visible), "claude");
  // Nothing usable remembered, or no roster yet: the server picks the first available.
  assert.equal(preferredVisibleHarness({ favorites: ["codex::a/b"], recents: [] }, visible), undefined);
  assert.equal(preferredVisibleHarness(prefs, undefined), undefined);
});
