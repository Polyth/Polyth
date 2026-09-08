// The composer must never offer a control the send would refuse: the model
// list belongs to the current harness, the thinking control exists only where
// the model advertises levels, and the attach pickers follow the same
// per-modality support the server admits with.
import test from "node:test";
import assert from "node:assert/strict";
import type { ModelDescriptor } from "@polyth/contracts";
import { effectiveAttachmentSupport } from "@polyth/contracts";
import { modelSupportsThinking } from "@polyth/models/model-presentation";
import { harnessModelCatalog, composerModelAbsence } from "../src/composer/discovery.ts";

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
};

const { getModelThinking, resolveComposerThinking, setModelThinking } =
  await import("../src/thinkingPrefs.ts");

const CATALOG: ModelDescriptor[] = [
  { harnessId: "codex", providerID: "openai", modelID: "gpt-5-codex", name: "GPT-5 Codex", variants: ["low", "high", "xhigh"], defaultVariant: "medium" },
  { harnessId: "codex", providerID: "openai", modelID: "gpt-5", name: "GPT-5", variants: ["low", "high"], defaultVariant: "low" },
  { harnessId: "claude", providerID: "anthropic", modelID: "sonnet", name: "Sonnet", variants: ["low", "medium", "high", "xhigh", "max"] },
  { harnessId: "claude", providerID: "anthropic", modelID: "haiku", name: "Haiku" },
  { harnessId: "cursor", providerID: "cursor", modelID: "auto", name: "Auto" },
];

const available = { state: "available" as const };

test("switching harness switches the model catalog", () => {
  const codex = harnessModelCatalog({ models: CATALOG, harnessId: "codex", discovery: available });
  assert.deepEqual(
    codex.state === "available" ? codex.items.map((model) => model.modelID) : [],
    ["gpt-5-codex", "gpt-5"],
  );
  const claude = harnessModelCatalog({ models: CATALOG, harnessId: "claude", discovery: available });
  assert.deepEqual(
    claude.state === "available" ? claude.items.map((model) => model.modelID) : [],
    ["sonnet", "haiku"],
  );
  // No harness's models leak into another's picker.
  assert.equal(claude.state === "available" && claude.items.some((model) => model.harnessId === "codex"), false);
});

test("a harness still discovering reads as loading, not as having no models", () => {
  const catalog = harnessModelCatalog({ models: CATALOG, harnessId: "fresh", discovery: { state: "pending" } });
  assert.equal(catalog.state, "loading");
});

test("a harness that cannot answer shows its cause instead of an empty list", () => {
  const catalog = harnessModelCatalog({
    models: CATALOG,
    harnessId: "unsigned",
    discovery: { state: "unavailable", reason: "Cursor is not signed in." },
  });
  assert.equal(catalog.state, "unavailable");
  assert.equal(catalog.state === "unavailable" ? catalog.reason : "", "Cursor is not signed in.");
});

test("a harness that really has no models is empty, which is a different thing", () => {
  const catalog = harnessModelCatalog({ models: CATALOG, harnessId: "bare", discovery: { state: "empty" } });
  assert.equal(catalog.state, "empty");
});

test("a live catalog wins over a stale unavailable report", () => {
  // Discovery failed on a later poll, but the harness already has models: the
  // picker must not empty itself under the user.
  const catalog = harnessModelCatalog({
    models: CATALOG,
    harnessId: "codex",
    discovery: { state: "unavailable", reason: "transient" },
  });
  assert.equal(catalog.state, "available");
});

test("an engine with a hidden native model is not treated as missing models", () => {
  const catalog = harnessModelCatalog({ models: CATALOG, harnessId: "bare", discovery: { state: "empty" } });
  assert.equal(composerModelAbsence({ catalog, nativeDefault: true }), "none");
});

test("loading and a named failure are absences, even if nativeDefault is set", () => {
  assert.equal(
    composerModelAbsence({ catalog: { state: "loading" }, nativeDefault: true }),
    "loading",
  );
  assert.equal(
    composerModelAbsence({
      catalog: { state: "unavailable", reason: "Cursor is not signed in." },
      nativeDefault: true,
    }),
    "unavailable",
  );
});

test("models that cannot do a text workflow never reach the picker", () => {
  const catalog = harnessModelCatalog({
    models: [
      { harnessId: "h", providerID: "p", modelID: "image-only", name: "Image only", capabilities: ["input:image", "output:image"] },
      { harnessId: "h", providerID: "p", modelID: "chat", name: "Chat", capabilities: ["input:text", "output:text"] },
    ],
    harnessId: "h",
    discovery: available,
  });
  assert.deepEqual(catalog.state === "available" ? catalog.items.map((model) => model.modelID) : [], ["chat"]);
});

test("the thinking control exists only for a model that advertises levels", () => {
  assert.equal(modelSupportsThinking(CATALOG[0]), true);
  assert.equal(modelSupportsThinking(CATALOG[3]), false, "Haiku advertises no effort levels");
  assert.equal(modelSupportsThinking(undefined), false);
});

test("no preference takes the model's own default level", () => {
  assert.deepEqual(
    resolveComposerThinking({ descriptor: CATALOG[1]!, configThinking: undefined }),
    { variant: "low", reconciled: false },
  );
});

test("a default the model does not actually advertise is not sent", () => {
  // Codex reports defaultReasoningEffort separately from its effort list; a
  // default missing from that list is a backend inconsistency, not a variant.
  const resolved = resolveComposerThinking({ descriptor: CATALOG[0]!, configThinking: undefined });
  assert.equal(resolved.variant, undefined);
  assert.equal(resolved.reconciled, false);
});

test("an explicit Auto is a real user choice the model default cannot override", () => {
  assert.deepEqual(
    resolveComposerThinking({ descriptor: CATALOG[1]!, configThinking: null }),
    { reconciled: false },
  );
});

test("a remembered level for this model is honored", () => {
  assert.deepEqual(
    resolveComposerThinking({ descriptor: CATALOG[1]!, configThinking: undefined, savedThinking: "high" }),
    { variant: "high", reconciled: false },
  );
});

test("a remembered level the new model lacks is reconciled to its default", () => {
  const resolved = resolveComposerThinking({
    descriptor: CATALOG[1]!,
    configThinking: undefined,
    savedThinking: "xhigh",
  });
  // Never sent, never silently kept: the control shows the effective value.
  assert.deepEqual(resolved, { variant: "low", reconciled: true });
});

test("a level carried onto a model with no levels is dropped and reported", () => {
  const resolved = resolveComposerThinking({ descriptor: CATALOG[3]!, configThinking: "high" });
  assert.equal(resolved.variant, undefined);
  assert.equal(resolved.reconciled, true);
});

test("a session default applies only until the user chooses for the model", () => {
  assert.equal(
    resolveComposerThinking({ descriptor: CATALOG[2]!, configThinking: undefined, sessionDefault: "max" }).variant,
    "max",
  );
  assert.equal(
    resolveComposerThinking({
      descriptor: CATALOG[2]!,
      configThinking: undefined,
      savedThinking: "low",
      sessionDefault: "max",
    }).variant,
    "low",
  );
});

test("remembered levels stay independent per model across a harness switch", () => {
  mem.clear();
  setModelThinking(CATALOG[1]!, "high");
  setModelThinking(CATALOG[2]!, "max");
  assert.equal(getModelThinking(CATALOG[1]!), "high");
  assert.equal(getModelThinking(CATALOG[2]!), "max");
  // Switching harness cannot make one model's level apply to the other's.
  assert.equal(
    resolveComposerThinking({ descriptor: CATALOG[2]!, configThinking: undefined, savedThinking: getModelThinking(CATALOG[2]!) }).variant,
    "max",
  );
  assert.equal(
    resolveComposerThinking({ descriptor: CATALOG[1]!, configThinking: undefined, savedThinking: getModelThinking(CATALOG[1]!) }).variant,
    "high",
  );
});

// ---- attachment pickers ----------------------------------------------------

/** The composer's inputs: the runtime-features payload, verbatim. */
const composerSupport = (features: {
  attachmentSupport: Record<string, "native" | "emulated" | "unsupported">;
  remote?: boolean;
  materializeAvailable?: boolean;
}, modelCapabilities?: string[]) => effectiveAttachmentSupport(
  {
    streaming: true, permissions: false, questions: false, compaction: false, subagents: false,
    attachments: { modalities: features.attachmentSupport },
  } as never,
  modelCapabilities,
  features.remote === true,
  features.materializeAvailable === true,
);

test("one unsupported modality disables that picker only", () => {
  const support = composerSupport({
    attachmentSupport: { image: "native", file: "emulated", pdf: "unsupported", audio: "unsupported" },
    materializeAvailable: true,
  });
  assert.equal(support.image, "native");
  assert.equal(support.file, "emulated");
  assert.equal("pdf" in support, false);
  assert.equal("audio" in support, false);
  // The Add menu stays operable because something is still attachable.
  assert.ok(Object.values(support).some((level) => level === "native" || level === "emulated"));
});

test("the selected model narrows what the harness offers", () => {
  const features = { attachmentSupport: { image: "native" as const, file: "native" as const }, materializeAvailable: true };
  // A model that reports modalities but not images cannot take one.
  const textOnly = composerSupport(features, ["input:text", "output:text"]);
  assert.equal("image" in textOnly, false);
  const withImages = composerSupport(features, ["input:text", "input:image", "output:text"]);
  assert.equal(withImages.image, "native");
  // Files are not a model input modality, so they follow the harness.
  assert.equal(textOnly.file, "native");
});

test("a remote project without materialization cannot offer file attachments", () => {
  const support = composerSupport({
    attachmentSupport: { file: "native", image: "native" },
    remote: true,
    materializeAvailable: false,
  });
  assert.equal("file" in support, false);
  assert.equal(support.image, "native");
});

test("a remote project that can materialize offers files as emulated", () => {
  const support = composerSupport({
    attachmentSupport: { file: "native" },
    remote: true,
    materializeAvailable: true,
  });
  assert.equal(support.file, "emulated");
});

test("the composer's support changes with the harness it will send to", () => {
  const nativeFiles = composerSupport({ attachmentSupport: { file: "native" }, materializeAvailable: true });
  const emulatedFiles = composerSupport({ attachmentSupport: { file: "emulated" }, materializeAvailable: true });
  const noFiles = composerSupport({ attachmentSupport: { file: "unsupported" }, materializeAvailable: true });
  assert.equal(nativeFiles.file, "native");
  assert.equal(emulatedFiles.file, "emulated");
  assert.equal("file" in noFiles, false);
});

test("the composer reads the server's flags instead of assuming them", async () => {
  const { readFile } = await import("node:fs/promises");
  const composer = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  // The old bug: `remote` and `materializeAvailable` hardcoded to false here,
  // so the composer offered attachments that the send then refused.
  assert.match(composer, /runtimeFeatures\.remote === true/);
  assert.match(composer, /runtimeFeatures\.materializeAvailable === true/);
  // No vendor branching may re-enter the composer.
  assert.doesNotMatch(composer, /harness(Id)?\s*===\s*["'](codex|claude|cursor|opencode|acp)["']/);
});
