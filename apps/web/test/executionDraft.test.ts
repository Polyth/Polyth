import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearDraftExecutionConfig,
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
