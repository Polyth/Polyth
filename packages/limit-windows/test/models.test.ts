import test from "node:test";
import assert from "node:assert/strict";
import { rankModels, type CatalogModel } from "../src/models.ts";

const row = (modelID: string, patch: Partial<CatalogModel> = {}): CatalogModel => ({ providerID: "p", modelID, name: modelID, ...patch });
const first = (models: CatalogModel[], source = { providerId: "x" }, windowId = "5h") => rankModels(models, source, windowId)[0]?.modelID;

test("Claude: the alias rows rank by what they are called", () => {
  assert.equal(first([row("default", { resolvedModelID: "claude-opus-5-5" }), row("opus"), row("sonnet"), row("haiku")]), "haiku");
});

test("Codex: the mini model beats the rest", () => {
  assert.equal(first([row("gpt-5.5"), row("gpt-5.5-codex"), row("gpt-5.5-codex-mini")]), "gpt-5.5-codex-mini");
});

test("Codex as it lists today: Luna over Terra, the older Luna first", () => {
  assert.equal(first([row("gpt-6-luna"), row("gpt-5.6-terra"), row("gpt-5.6-luna")]), "gpt-5.6-luna");
});

test("Claude as it lists today: the alias over a dated id of the same tier", () => {
  assert.equal(first([
    row("default", { resolvedModelID: "claude-opus-5-5" }),
    row("opus", { resolvedModelID: "claude-opus-5-5" }),
    row("sonnet", { resolvedModelID: "claude-sonnet-5-5" }),
    row("haiku", { resolvedModelID: "claude-haiku-5-5" }),
    row("claude-haiku-4-5-20251001"),
    row("claude-sonnet-5"),
  ]), "haiku");
});

test("an older version wins a tie; a date is not a version", () => {
  assert.equal(first([row("flash-3-20251001"), row("flash-2-20260101")]), "flash-2-20260101");
  assert.equal(first([row("gemini-3.8-flash"), row("gemini-3.10-flash")]), "gemini-3.8-flash");
});

test("a free route is the last resort: it may not count against the plan", () => {
  assert.equal(first([row("beam-free"), row("big-model")]), "big-model");
  assert.equal(first([row("beam-free")]), "beam-free");
});

test("flash-lite beats flash, flash beats pro", () => {
  assert.equal(first([row("gemini-3.8-pro"), row("gemini-3.8-flash"), row("gemini-3.8-flash-lite")]), "gemini-3.8-flash-lite");
  assert.equal(first([row("gemini-3.8-pro"), row("gemini-3.8-flash")]), "gemini-3.8-flash");
});

test("a known price decides over the name", () => {
  assert.equal(first([
    row("kimi-k3-mini", { cost: { input: 4, output: 12 } }),
    row("mimo-v2.6-pro", { cost: { input: 0.1, output: 0.3 } }),
    row("glm-5.1", { cost: { input: 1, output: 3 } }),
  ]), "mimo-v2.6-pro");
});

test("a zero price is not a known price: it may be a route the plan does not meter", () => {
  assert.equal(first([row("free-mini", { cost: { input: 0, output: 0 } }), row("paid", { cost: { input: 1, output: 3 } })]), "paid");
});

test("what cannot answer a line of text is left out", () => {
  const ranked = rankModels([
    row("text-embedding-3-small"),
    row("gpt-image-2-mini"),
    row("tts-mini"),
    row("no-input", { capabilities: ["input:none"] }),
    row("signed-out-mini", { connected: false }),
    row("gpt-5.5"),
  ], { providerId: "x" }, "5h");
  assert.deepEqual(ranked.map((model) => model.modelID), ["gpt-5.5"]);
});

test("an account-default alias is used only when nothing else is listed", () => {
  assert.equal(first([row("default"), row("big-model")]), "big-model");
  assert.equal(first([row("default")]), "default");
});

test("catalog order breaks a tie", () => {
  assert.equal(first([row("alpha"), row("beta")]), "alpha");
});

test("Antigravity: each group only offers the models it meters", () => {
  const models = [row("gemini-3.8-flash"), row("gemini-3.8-pro"), row("claude-sonnet-5-5"), row("gpt-oss-mini")];
  const antigravity = { providerId: "antigravity" };
  assert.deepEqual(rankModels(models, antigravity, "google-5h").map((model) => model.modelID), ["gemini-3.8-flash", "gemini-3.8-pro"]);
  assert.deepEqual(rankModels(models, antigravity, "third-party-5h").map((model) => model.modelID), ["gpt-oss-mini", "claude-sonnet-5-5"]);
  const account = { providerId: "antigravity-work", account: { family: "antigravity", harnessId: "antigravity-work", label: "Work" } };
  assert.equal(rankModels(models, account, "third-party-5h")[0]?.modelID, "gpt-oss-mini");
});

test("no fitting row answers an empty list", () => {
  assert.deepEqual(rankModels([], { providerId: "x" }, "5h"), []);
});
