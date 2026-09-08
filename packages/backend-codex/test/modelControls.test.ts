import assert from "node:assert/strict";
import { test } from "node:test";
import { createCodexRuntime } from "../src/index.ts";
import { fakeRpc } from "../../harness-runtime/test/rpcPeer.ts";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };

/** App Server v2 `model/list` rows, exactly as codex-cli 0.153.4 reports them. */
const MODEL_LIST = {
  data: [
    {
      id: "gpt-5.5-codex",
      model: "gpt-5.5-codex",
      displayName: "GPT-5.5 Codex",
      description: "",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "" },
        { reasoningEffort: "medium", description: "" },
        { reasoningEffort: "high", description: "" },
        { reasoningEffort: "xhigh", description: "" },
      ],
      defaultReasoningEffort: "medium",
      inputModalities: ["text", "image"],
      isDefault: true,
    },
    {
      id: "internal",
      model: "internal-preview",
      displayName: "Internal",
      hidden: true,
      inputModalities: ["text"],
    },
  ],
};

const started = async () => {
  const f = fakeRpc();
  const turns: Record<string, unknown>[] = [];
  f.handle(async (method, params) => {
    if (method === "thread/start") return { thread: { id: "native" }, model: "gpt-5.5-codex", modelProvider: "openai" };
    if (method === "model/list") return MODEL_LIST;
    if (method === "turn/start") { turns.push(params); return { turn: { id: `t${turns.length}` } }; }
    return {};
  });
  const rt = await createCodexRuntime(context, f.rpc);
  await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
  return { f, rt, turns };
};

test("model/list becomes a catalog with reasoning efforts as variants and a default", async () => {
  const { rt } = await started();
  const models = await rt.models();
  assert.equal(models.length, 1, "hidden rows are not offered");
  assert.deepEqual(models[0]!.variants, ["low", "medium", "high", "xhigh"]);
  assert.equal(models[0]!.defaultVariant, "medium");
  assert.equal(models[0]!.name, "GPT-5.5 Codex");
  assert.equal(models[0]!.providerID, "openai", "the live thread's provider is used, not a guess");
  assert.ok(models[0]!.capabilities?.includes("input:image"));
});

test("a selected variant reaches turn/start as the native effort field", async () => {
  const { rt, turns } = await started();
  const outcome = await rt.startTurnOperation!({
    sessionId: "canonical",
    text: "task",
    model: { providerID: "openai", modelID: "gpt-5.5-codex", variant: "xhigh" },
  }, "submit");
  assert.equal(outcome.kind, "confirmed");
  assert.equal(turns[0]!.effort, "xhigh");
  assert.equal(turns[0]!.model, "gpt-5.5-codex");
});

test("no variant sends no effort key at all, so the native default applies", async () => {
  const { rt, turns } = await started();
  await rt.startTurnOperation!({
    sessionId: "canonical",
    text: "task",
    model: { providerID: "openai", modelID: "gpt-5.5-codex" },
  }, "submit");
  assert.equal("effort" in turns[0]!, false);
});

test("a variant the model does not advertise is rejected before the RPC", async () => {
  const { rt, turns } = await started();
  const outcome = await rt.startTurnOperation!({
    sessionId: "canonical",
    text: "task",
    model: { providerID: "openai", modelID: "gpt-5.5-codex", variant: "ultra" },
  }, "submit");
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.kind === "rejected" && outcome.code, "invalid-variant");
  assert.equal(turns.length, 0, "an invalid variant never becomes a native turn");
});

test("a provider id that differs from the thread's provider is not a foreign model", async () => {
  // `model/list` carries no provider field, so the catalog's providerID is a
  // property of the thread. Rejecting on it produced false refusals.
  const { rt, turns } = await started();
  const outcome = await rt.startTurnOperation!({
    sessionId: "canonical",
    text: "task",
    model: { providerID: "azure", modelID: "gpt-5.5-codex", variant: "high" },
  }, "submit");
  assert.equal(outcome.kind, "confirmed");
  assert.equal(turns[0]!.effort, "high");
});

test("a model Codex does not have is rejected as an unknown model", async () => {
  const { rt } = await started();
  const outcome = await rt.startTurnOperation!({
    sessionId: "canonical",
    text: "task",
    model: { providerID: "anthropic", modelID: "sonnet" },
  }, "submit");
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.kind === "rejected" && outcome.code, "invalid-model");
});

test("the catalog is fetched once per runtime, not per turn", async () => {
  const f = fakeRpc();
  let listCalls = 0;
  f.handle(async (method) => {
    if (method === "thread/start") return { thread: { id: "native" } };
    if (method === "model/list") { listCalls++; return MODEL_LIST; }
    if (method === "turn/start") return { turn: { id: "t" } };
    return {};
  });
  const rt = await createCodexRuntime(context, f.rpc);
  await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
  const model = { providerID: "openai", modelID: "gpt-5.5-codex", variant: "low" };
  await Promise.all([
    rt.models(),
    rt.startTurnOperation!({ sessionId: "canonical", text: "a", model }, "one"),
  ]);
  await rt.startTurnOperation!({ sessionId: "canonical", text: "b", model }, "two");
  assert.equal(listCalls, 1);
});

test("images travel as native input blocks and links as image URLs", async () => {
  const { rt, turns } = await started();
  await rt.startTurnOperation!({
    sessionId: "canonical",
    text: "look",
    attachments: [
      { id: "i", name: "shot.png", mime: "image/png", size: 4, kind: "image", path: "shot.png" },
      { id: "l", name: "link", mime: "text/uri-list", size: 0, kind: "url", url: "https://example.com/x.png" },
    ],
  }, "submit");
  assert.deepEqual(turns[0]!.input, [
    { type: "text", text: "look" },
    { type: "localImage", path: "/tmp/shot.png" },
    { type: "image", url: "https://example.com/x.png" },
  ]);
});

test("a PDF and an audio clip are refused with a product-level reason", async () => {
  const { rt } = await started();
  for (const ref of [
    { id: "p", name: "spec.pdf", mime: "application/pdf", size: 1, path: "spec.pdf" },
    { id: "a", name: "note.wav", mime: "audio/wav", size: 1, path: "note.wav" },
  ]) {
    const outcome = await rt.startTurnOperation!({ sessionId: "canonical", text: "x", attachments: [ref] }, "submit");
    assert.equal(outcome.kind, "rejected");
    assert.equal(outcome.kind === "rejected" && outcome.code, "unsupported");
    assert.match(
      outcome.kind === "rejected" ? outcome.message : "",
      /attachments are not supported by the Codex engine\./,
    );
  }
});

test("Codex declares text files as emulated, so the server projects them into the prompt", async () => {
  const { rt, turns } = await started();
  const capabilities = await rt.capabilities();
  assert.equal(capabilities.attachments?.modalities.file, "emulated");
  // The server strips the projected ref and appends the section, so the
  // adapter receives prompt text and no file ref to complain about.
  const outcome = await rt.startTurnOperation!({
    sessionId: "canonical",
    text: "review this\n\nAttached file: src/a.ts\n```\nexport const a = 1;\n```",
  }, "submit");
  assert.equal(outcome.kind, "confirmed");
  assert.match(String((turns[0]!.input as Array<{ text?: string }>)[0]!.text), /Attached file: src\/a\.ts/);
});
