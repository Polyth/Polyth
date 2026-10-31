// The composer must never offer a control the send would refuse: the model
// list belongs to the current harness, the thinking control exists only where
// the model advertises levels, and the attach pickers follow the same
// per-modality support the server admits with.
import test from "node:test";
import assert from "node:assert/strict";
import type { ModelDescriptor } from "@polyth/contracts";
import { effectiveAttachmentSupport } from "@polyth/contracts";
import { modelSupportsThinking } from "@polyth/models/model-presentation";
import {
  advanceModelAbsenceGate,
  emptyModelCatalogReason,
  harnessModelCatalog,
  composerModelAbsence,
  IDLE_MODEL_ABSENCE_GATE,
  MODEL_ABSENCE_GRACE_MS,
  composerChipModel,
  lastChosenHarnessModel,
  nextTurnModelRef,
  routeDefaultModel,
  routeMovingTransition,
  routeSwitchedByPerson,
  sendableRouteModel,
  visibleFallbackModel,
} from "../src/composer/discovery.ts";
import { hiddenModelMatcher } from "@polyth/models";
import { composerRecoveryKind } from "@polyth/models/runtime-catalog";

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
};

const {
  composerThinkingChoice,
  getLastHarnessModels,
  getLastHarnessModelsRecord,
  getModelThinking,
  parseLastHarnessModels,
  recordedSessionThinking,
  rememberHarnessModel,
  replaceLastHarnessModels,
  resolveComposerThinking,
  setModelThinking,
  subscribeLastHarnessModels,
} = await import("@polyth/models/web-prefs");

const CATALOG: ModelDescriptor[] = [
  { harnessId: "codex", providerID: "openai", modelID: "gpt-5-codex", name: "GPT-5 Codex", variants: ["low", "high", "xhigh"], defaultVariant: "medium" },
  { harnessId: "codex", providerID: "openai", modelID: "gpt-5", name: "GPT-5", variants: ["low", "high"], defaultVariant: "low" },
  { harnessId: "claude", providerID: "anthropic", modelID: "sonnet", name: "Sonnet", variants: ["low", "medium", "high", "xhigh", "max", "ultracode"] },
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

test("an account-hidden catalog offers Harnesses, while a starting runtime offers Reconnect", () => {
  assert.equal(composerRecoveryKind({ state: "empty", code: "models-hidden" }), "manage-harnesses");
  assert.equal(composerRecoveryKind({ state: "empty", code: "runtime-empty" }), "reconnect");
  assert.match(emptyModelCatalogReason({ state: "empty", code: "models-hidden" }) ?? "", /Settings → Harnesses/);
  assert.match(emptyModelCatalogReason({ state: "empty", code: "runtime-empty" }) ?? "", /still be starting/);
  assert.equal(emptyModelCatalogReason({ state: "empty" }), undefined,
    "an unclassified empty answer keeps the generic guidance");
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

test("a chat restores the effort its own model recorded", () => {
  const sessionModel = { harnessId: "codex", providerID: "openai", modelID: "gpt-5", variant: "high" };
  const selected = { harnessId: "codex", providerID: "openai", modelID: "gpt-5" };
  assert.equal(recordedSessionThinking(selected, sessionModel), "high");
  // The record wins over an effort last chosen for the same model elsewhere.
  assert.equal(
    resolveComposerThinking({
      descriptor: CATALOG[1]!,
      configThinking: undefined,
      recordedThinking: recordedSessionThinking(selected, sessionModel),
      savedThinking: "low",
      sessionDefault: "max",
    }).variant,
    "high",
  );
});

test("a chat recorded on the model default does not inherit another chat's effort", () => {
  const sessionModel = { harnessId: "codex", providerID: "openai", modelID: "gpt-5" };
  const selected = { harnessId: "codex", providerID: "openai", modelID: "gpt-5" };
  assert.equal(recordedSessionThinking(selected, sessionModel), null);
  assert.deepEqual(
    resolveComposerThinking({
      descriptor: CATALOG[1]!,
      configThinking: undefined,
      recordedThinking: recordedSessionThinking(selected, sessionModel),
      savedThinking: "high",
      sessionDefault: "max",
    }),
    { reconciled: false },
  );
});

test("another model's chat record never applies", () => {
  assert.equal(
    recordedSessionThinking(
      { harnessId: "codex", providerID: "openai", modelID: "gpt-5-codex" },
      { harnessId: "codex", providerID: "openai", modelID: "gpt-5", variant: "high" },
    ),
    undefined,
  );
  assert.equal(
    recordedSessionThinking(
      { harnessId: "claude", providerID: "anthropic", modelID: "sonnet" },
      { harnessId: "codex", providerID: "anthropic", modelID: "sonnet", variant: "high" },
    ),
    undefined,
  );
  // A projection model carries no harness; the session's resolved route does.
  assert.equal(
    recordedSessionThinking(
      { harnessId: "claude", providerID: "anthropic", modelID: "sonnet" },
      { providerID: "anthropic", modelID: "sonnet", variant: "high" },
      "codex",
    ),
    undefined,
  );
  assert.equal(
    recordedSessionThinking(
      { harnessId: "codex", providerID: "openai", modelID: "gpt-5" },
      { providerID: "openai", modelID: "gpt-5", variant: "high" },
    ),
    undefined,
    "a legacy unqualified session belongs to OpenCode, not to every harness",
  );
  assert.equal(
    recordedSessionThinking(
      { harnessId: "codex", providerID: "openai", modelID: "gpt-5" },
      { providerID: "openai", modelID: "gpt-5", variant: "high" },
      "codex",
    ),
    "high",
  );
});

test("the controlled picker shows explicit choices and leaves inherited defaults unset", () => {
  // Nothing explicit: the picker must inherit the model/default label instead
  // of presenting the saved preference as a choice.
  assert.equal(composerThinkingChoice({ configThinking: undefined }), undefined);
  assert.equal(
    composerThinkingChoice({ configThinking: undefined, recordedThinking: "high", savedThinking: "low" }),
    "high",
  );
  assert.equal(
    composerThinkingChoice({ configThinking: undefined, recordedThinking: null, savedThinking: "low" }),
    null,
  );
  assert.equal(composerThinkingChoice({ configThinking: "low", recordedThinking: "high" }), "low");
  assert.equal(composerThinkingChoice({ configThinking: null, savedThinking: "high" }), null);
});

test("an explicit pending choice still wins over the chat's record", () => {
  assert.equal(
    resolveComposerThinking({
      descriptor: CATALOG[1]!,
      configThinking: "low",
      recordedThinking: "high",
      savedThinking: "high",
    }).variant,
    "low",
  );
  assert.deepEqual(
    resolveComposerThinking({ descriptor: CATALOG[1]!, configThinking: null, recordedThinking: "high" }),
    { reconciled: false },
  );
});

test("ultracode is a picker variant like any other level", () => {
  assert.deepEqual(
    resolveComposerThinking({ descriptor: CATALOG[2]!, configThinking: "ultracode" }),
    { variant: "ultracode", reconciled: false },
  );
  assert.deepEqual(
    resolveComposerThinking({ descriptor: CATALOG[2]!, configThinking: undefined, savedThinking: "ultracode" }),
    { variant: "ultracode", reconciled: false },
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
  assert.equal("audio" in support, false);
  // A PDF stays attachable: Polyth sends its extracted text instead.
  assert.equal(support.pdf, "emulated");
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
  // File context is an engine/tool transport, not a direct model modality.
  assert.equal(textOnly.file, "native");
  const withFiles = composerSupport(features, ["input:text", "input:file", "output:text"]);
  assert.equal(withFiles.file, "native");
});

test("a remote project without materialization cannot offer file attachments", () => {
  const support = composerSupport({
    attachmentSupport: { file: "native", image: "native" },
    remote: true,
    materializeAvailable: false,
  });
  assert.equal("file" in support, false);
  assert.equal(support.image, "native");
  // Polyth cannot read the PDF either, so it is not offered.
  assert.equal("pdf" in support, false);
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

test("the new-session harness picker is controlled by the composer execution owner", async () => {
  const { readFile } = await import("node:fs/promises");
  const composer = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  assert.match(composer, /harnessSelection:\s*session\s*\?\s*session\.harness\s*:\s*newSessionHarnessSelection/);
  assert.match(composer, /pendingHarnessSelection:\s*cfg\.harness/);
  assert.match(composer, /onSelectHarness:\s*pickComposerHarness/);
  assert.doesNotMatch(composer, /onSelectHarness:\s*session\s*\?\s*pickComposerHarness/);
  assert.doesNotMatch(composer, /pendingHarnessSelection:\s*session\s*\?\s*cfg\.harness/);
  assert.match(composer, /const stagedHarnessId = cfg\.harness\?\.mode === "pinned"/);
  assert.match(composer, /prospectiveHarnessId = stagedHarnessId \?\? transitionHarnessId/);
  assert.match(composer, /catalogHarnessId = stagedHarnessId\s*\?\?\s*transitionHarnessId/);
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

test("a transient catalogue gap does not claim absence before the grace, and never flashes", () => {
  let gate = advanceModelAbsenceGate(IDLE_MODEL_ABSENCE_GATE, true, 1_000);
  assert.equal(gate.visible, false, "a route change is not an absent engine");
  assert.equal(gate.nextChangeAt, 1_000 + MODEL_ABSENCE_GRACE_MS, "the caller gets the instant to re-check");

  gate = advanceModelAbsenceGate(gate, true, 1_000 + MODEL_ABSENCE_GRACE_MS - 1);
  assert.equal(gate.visible, false);
  gate = advanceModelAbsenceGate(gate, true, 1_000 + MODEL_ABSENCE_GRACE_MS);
  assert.equal(gate.visible, true, "a gap that outlives the grace is shown honestly");

  // Once shown it keeps its minimum beat: a catalogue answering immediately
  // afterwards must not blink the notice away.
  const shownAt = 1_000 + MODEL_ABSENCE_GRACE_MS;
  const kept = advanceModelAbsenceGate(gate, false, shownAt + 50);
  assert.equal(kept.visible, true);
  assert.equal(advanceModelAbsenceGate(kept, false, gate.until!).visible, false);

  // A catalogue that answers inside the grace never shows anything at all.
  const early = advanceModelAbsenceGate(IDLE_MODEL_ABSENCE_GATE, true, 0);
  assert.equal(advanceModelAbsenceGate(early, false, 200).visible, false);

  // A settled empty catalogue keeps its long cold-backend delay.
  const cold = advanceModelAbsenceGate(IDLE_MODEL_ABSENCE_GATE, true, 0, 8_000);
  assert.equal(cold.visible, false);
  assert.equal(advanceModelAbsenceGate(cold, true, 8_000).visible, true);
});

test("a model the current route cannot route is never a sendable selection", () => {
  const cursor = [{ harnessId: "cursor", providerID: "cursor", modelID: "auto", name: "Auto" }];
  assert.equal(
    sendableRouteModel(cursor, { providerID: "opencode", modelID: "big-pickle", harnessId: "opencode" }),
    undefined,
    "the previous harness's model is dropped, not sent",
  );
  assert.equal(sendableRouteModel(cursor, { providerID: "openai", modelID: "luna", harnessId: "codex" }), undefined);
  assert.equal(sendableRouteModel(cursor, undefined), undefined);
  assert.equal(sendableRouteModel(cursor, { providerID: "cursor", modelID: "auto", harnessId: "cursor" })?.name, "Auto");
});

test("the composer commits only the route's own catalogue selection", async () => {
  const { readFile } = await import("node:fs/promises");
  const composer = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  // The send path derives its descriptor (and therefore `sentModel`) from the
  // shared rule above, so an incompatible identity cannot reach the wire.
  assert.match(composer, /const selectedDescriptor = sendableRouteModel\(chatModels, selected\)/);
});

test("the unchosen fallback skips models hidden in Settings → Harnesses", () => {
  const catalog: ModelDescriptor[] = [
    { harnessId: "claude", providerID: "meta", modelID: "muse-spark", name: "Muse Spark" },
    { harnessId: "claude", providerID: "deepseek", modelID: "v4-flash", name: "DeepSeek V4 Flash" },
  ];
  const hideMuse = hiddenModelMatcher({ hiddenProviders: [], hiddenModels: ["claude::meta/muse-spark"], shownModels: [] });
  assert.equal(visibleFallbackModel(catalog, hideMuse, "claude")?.modelID, "v4-flash");
  const providerOff = hiddenModelMatcher({ hiddenProviders: ["claude::meta"], hiddenModels: [], shownModels: [] });
  assert.equal(visibleFallbackModel(catalog, providerOff, "claude")?.modelID, "v4-flash");
  const allOff = hiddenModelMatcher({ hiddenProviders: ["claude::meta", "claude::deepseek"], hiddenModels: [], shownModels: [] });
  assert.equal(visibleFallbackModel(catalog, allOff, "claude")?.modelID, "muse-spark");
  assert.equal(visibleFallbackModel([], hideMuse, "claude"), undefined);
});

test("the unchosen fallback prefers a favorite, then a recent model, still skipping hidden ones", () => {
  const catalog: ModelDescriptor[] = [
    { harnessId: "claude", providerID: "anthropic", modelID: "default", name: "Default" },
    { harnessId: "claude", providerID: "anthropic", modelID: "opus", name: "Opus" },
    { harnessId: "claude", providerID: "anthropic", modelID: "haiku", name: "Haiku" },
  ];
  const none = hiddenModelMatcher({ hiddenProviders: [], hiddenModels: [], shownModels: [] });
  // A favorite on another harness is skipped; the next key on this one wins.
  assert.equal(visibleFallbackModel(catalog, none, "claude", ["codex::openai/gpt-5", "claude::anthropic/opus", "claude::anthropic/haiku"])?.modelID, "opus");
  const hideOpus = hiddenModelMatcher({ hiddenProviders: [], hiddenModels: ["claude::anthropic/opus"], shownModels: [] });
  assert.equal(visibleFallbackModel(catalog, hideOpus, "claude", ["claude::anthropic/opus", "claude::anthropic/haiku"])?.modelID, "haiku");
  assert.equal(visibleFallbackModel(catalog, none, "claude", ["codex::openai/gpt-5"])?.modelID, "default");
});

test("a harness switch selects the model last chosen in that harness's chat picker", () => {
  const catalog: ModelDescriptor[] = [
    { harnessId: "claude", providerID: "anthropic", modelID: "default", name: "Default" },
    { harnessId: "claude", providerID: "anthropic", modelID: "opus", name: "Opus" },
    { harnessId: "claude", providerID: "anthropic", modelID: "haiku", name: "Haiku" },
  ];
  const none = hiddenModelMatcher({ hiddenProviders: [], hiddenModels: [], shownModels: [] });
  assert.equal(lastChosenHarnessModel(catalog, none, "claude", { providerID: "anthropic", modelID: "opus" })?.name, "Opus");
  // Nothing remembered: the caller's ordinary chain applies. Account-wide
  // recents are not a memory — a utility picker writes them too.
  assert.equal(lastChosenHarnessModel(catalog, none, "claude", undefined), undefined);
  // A remembered model the route no longer lists, or that this account hid, is skipped.
  assert.equal(lastChosenHarnessModel(catalog, none, "claude", { providerID: "anthropic", modelID: "sonnet-3" }), undefined);
  const hideHaiku = hiddenModelMatcher({ hiddenProviders: [], hiddenModels: ["claude::anthropic/haiku"], shownModels: [] });
  assert.equal(lastChosenHarnessModel(catalog, hideHaiku, "claude", { providerID: "anthropic", modelID: "haiku" }), undefined);
  // Another harness's row with the same ids never answers.
  assert.equal(lastChosenHarnessModel(catalog, none, "pi", { providerID: "anthropic", modelID: "opus" }), undefined);
  assert.equal(lastChosenHarnessModel(catalog, none, undefined, { providerID: "anthropic", modelID: "opus" }), undefined);
  // An untagged OpenCode row is OpenCode's.
  const opencode: ModelDescriptor[] = [{ providerID: "opencode", modelID: "big-pickle", name: "Big Pickle" }];
  assert.equal(lastChosenHarnessModel(opencode, none, "opencode", { providerID: "opencode", modelID: "big-pickle" })?.name, "Big Pickle");
});

test("each harness remembers its own last chosen model", () => {
  const original = getLastHarnessModelsRecord();
  try {
    replaceLastHarnessModels({});
    rememberHarnessModel("codex", { providerID: "openai", modelID: "gpt-5" });
    rememberHarnessModel("claude", { providerID: "anthropic", modelID: "opus" });
    rememberHarnessModel("claude", { providerID: "anthropic", modelID: "haiku", name: "Haiku" });
    assert.deepEqual(getLastHarnessModels(), {
      claude: { providerID: "anthropic", modelID: "haiku", name: "Haiku" },
      codex: { providerID: "openai", modelID: "gpt-5" },
    }, "a later pick replaces only its own harness");
    // Key order carries no meaning: the account merge rebuilds objects in the
    // base record's order, so a recency order would bounce between clients.
    assert.deepEqual(Object.keys(getLastHarnessModels()), ["claude", "codex"]);
    const recordBefore = getLastHarnessModelsRecord();
    let writes = 0;
    const unsubscribe = subscribeLastHarnessModels(() => { writes += 1; });
    try {
      rememberHarnessModel("codex", { providerID: "openai", modelID: "gpt-5" });
      assert.equal(writes, 0, "choosing the remembered model again writes nothing");
      assert.equal(getLastHarnessModelsRecord(), recordBefore);
    } finally {
      unsubscribe();
    }
    rememberHarnessModel("", { providerID: "openai", modelID: "gpt-5" });
    assert.equal(Object.keys(getLastHarnessModels()).length, 2, "a pick without a harness is not remembered");
    // Stored and synced as one tuple per harness, so a merge never splices fields.
    assert.deepEqual(getLastHarnessModelsRecord(), {
      claude: ["anthropic", "haiku", "Haiku"],
      codex: ["openai", "gpt-5"],
    });
    // Whatever order a synced copy arrives in, the record is canonical.
    replaceLastHarnessModels({ codex: ["openai", "gpt-5"], claude: ["anthropic", "haiku", "Haiku"] });
    assert.equal(JSON.stringify(getLastHarnessModelsRecord()), JSON.stringify({
      claude: ["anthropic", "haiku", "Haiku"],
      codex: ["openai", "gpt-5"],
    }));
    // The synced copy is untrusted JSON.
    assert.deepEqual(parseLastHarnessModels(JSON.stringify({
      codex: ["openai", "gpt-5", 42, "extra"],
      broken: ["openai"],
      object: { providerID: "openai", modelID: "gpt-5" },
      text: "openai/gpt-5",
    })), { codex: { providerID: "openai", modelID: "gpt-5" } });
    assert.deepEqual(parseLastHarnessModels("not json"), {});
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`h${String(index).padStart(2, "0")}`, ["p", "m"]]));
    const bounded = parseLastHarnessModels(JSON.stringify(many));
    assert.equal(Object.keys(bounded).length, 64, "a corrupt record stays small");
    // A full record still takes a new harness's pick.
    replaceLastHarnessModels(Object.fromEntries(Object.keys(bounded).map((harnessId) => [harnessId, ["p", "m"]])));
    rememberHarnessModel("zz-new", { providerID: "p", modelID: "fresh" });
    assert.equal(Object.keys(getLastHarnessModels()).length, 64);
    assert.deepEqual(getLastHarnessModels()["zz-new"], { providerID: "p", modelID: "fresh" });
  } finally {
    replaceLastHarnessModels(original);
  }
});

test("a switched route runs the last chosen model ahead of defaults; an unswitched one keeps its chain", () => {
  const catalog: ModelDescriptor[] = [
    { harnessId: "claude", providerID: "anthropic", modelID: "default", name: "Default" },
    { harnessId: "claude", providerID: "anthropic", modelID: "opus", name: "Opus" },
    { harnessId: "claude", providerID: "anthropic", modelID: "haiku", name: "Haiku" },
  ];
  const [, opus, haiku] = catalog as [ModelDescriptor, ModelDescriptor, ModelDescriptor];
  const projectDefault = { harnessId: "claude", providerID: "anthropic", modelID: "default" };
  // A tab switch answers with the harness's own memory, even over a default it could run.
  assert.deepEqual(routeDefaultModel({ models: catalog, switched: true, lastChosen: haiku, resolvedDefault: projectDefault, fallback: opus }), {
    preferred: haiku, route: haiku,
  });
  // Without a switch, the project/global default this route can run still wins…
  assert.deepEqual(routeDefaultModel({ models: catalog, switched: false, lastChosen: haiku, resolvedDefault: projectDefault, fallback: opus }), {
    preferred: projectDefault, route: projectDefault,
  });
  // …and a default from another harness gives way to the fallback (a favorite here), not to the memory.
  const elsewhere = { harnessId: "codex", providerID: "openai", modelID: "gpt-5" };
  assert.deepEqual(routeDefaultModel({ models: catalog, switched: false, lastChosen: haiku, resolvedDefault: elsewhere, fallback: opus }), {
    preferred: opus, route: opus,
  });
  // A switch to a harness with nothing remembered keeps the ordinary chain.
  assert.deepEqual(routeDefaultModel({ models: catalog, switched: true, resolvedDefault: elsewhere, fallback: opus }), {
    preferred: opus, route: opus,
  });
  // While the catalogue is empty nothing is listed, so no route model is claimed.
  assert.deepEqual(routeDefaultModel({ models: [], switched: true, resolvedDefault: projectDefault }), { preferred: projectDefault });
});

test("only a harness the person chose for the next message counts as a switch", () => {
  // A new chat: a harness tab chosen in its picker, not one followed from the
  // project default or a profile.
  assert.equal(routeSwitchedByPerson({ hasSession: false, draftHarnessExplicit: true }), true);
  assert.equal(routeSwitchedByPerson({ hasSession: false, draftHarnessExplicit: false }), false);
  // An open chat: a staged harness other than the one it runs on.
  assert.equal(routeSwitchedByPerson({ hasSession: true, stagedHarnessId: "codex", resolvedHarnessId: "claude" }), true);
  assert.equal(routeSwitchedByPerson({ hasSession: true, stagedHarnessId: "claude", resolvedHarnessId: "claude" }), false,
    "a tab back to the chat's own harness keeps the chat's model");
  // A server-side transition alone stages nothing here, and a new chat's flag
  // means nothing to an open one.
  assert.equal(routeSwitchedByPerson({ hasSession: true, resolvedHarnessId: "claude", draftHarnessExplicit: true }), false);
});

test("the chip names what the next message runs, including during a server-side switch", () => {
  const sessionModel = { harnessId: "claude", providerID: "anthropic", modelID: "opus" };
  const routeModel = { harnessId: "codex", providerID: "openai", modelID: "gpt-5" };
  const pendingRouteModel = { harnessId: "codex", providerID: "openai", modelID: "gpt-5-mini" };
  const movingTransition = { targetHarnessId: "codex", launch: { model: { providerID: "openai", modelID: "gpt-5-codex", variant: "high" } } };
  // A staged harness: what its submit commits, else the display-only anchor.
  assert.deepEqual(composerChipModel({ stagedHarness: true, movingTransition, sessionModel, routeModel, pendingRouteModel }), routeModel);
  assert.deepEqual(composerChipModel({ stagedHarness: true, sessionModel, pendingRouteModel }), pendingRouteModel);
  // A switch to another harness nobody staged here (another client, an agent,
  // a submit already sent): it launches what it recorded, so the chip shows
  // that, never this account's memory.
  assert.deepEqual(composerChipModel({ stagedHarness: false, movingTransition, sessionModel, routeModel, pendingRouteModel }), {
    providerID: "openai", modelID: "gpt-5-codex", variant: "high", harnessId: "codex",
  });
  assert.deepEqual(composerChipModel({ stagedHarness: false, movingTransition: { targetHarnessId: "codex" }, sessionModel, routeModel, pendingRouteModel }),
    pendingRouteModel, "a transition launching its harness's own default claims no model");
  assert.equal(composerChipModel({ stagedHarness: false, movingTransition: { targetHarnessId: "codex" }, sessionModel, routeModel }), undefined);
  // No route change: the chat's model, then (a new chat) the route model.
  assert.deepEqual(composerChipModel({ stagedHarness: false, sessionModel, routeModel }), sessionModel);
  assert.deepEqual(composerChipModel({ stagedHarness: false, routeModel }), routeModel);
});

test("a server-side transition that keeps the harness is not a route change", () => {
  // Runtime restart, rewind or compaction legs and stale-history resets write
  // a transition to the chat's own harness, usually without a launch.
  const restart = { targetHarnessId: "claude" };
  assert.equal(routeMovingTransition(restart, "claude"), undefined);
  assert.equal(routeMovingTransition({ ...restart, launch: { model: { providerID: "anthropic", modelID: "haiku" } } }, "claude"), undefined);
  const toCodex = { targetHarnessId: "codex" };
  assert.equal(routeMovingTransition(toCodex, "claude"), toCodex);
  assert.equal(routeMovingTransition(undefined, "claude"), undefined);
  // So the chip keeps the chat's model through a restart.
  const sessionModel = { harnessId: "claude", providerID: "anthropic", modelID: "opus" };
  const moving = routeMovingTransition(restart, "claude");
  assert.deepEqual(composerChipModel({ stagedHarness: false, ...(moving ? { movingTransition: moving } : {}), sessionModel }), sessionModel);
});

test("the next message names the model the chip shows", () => {
  const configModel = { providerID: "openai", modelID: "explicit" };
  const sessionModel = { providerID: "opencode", modelID: "big-pickle" };
  const profileModel = { providerID: "anthropic", modelID: "profile" };
  const preferred = { harnessId: "pi", providerID: "anthropic", modelID: "preferred" };
  // An explicit choice always wins.
  assert.equal(nextTurnModelRef({ configModel, stagedHarness: true, movingTransition: true, sessionModel, preferred }), configModel);
  // The chat's own route: its model, then a profile's, then the default.
  assert.equal(nextTurnModelRef({ stagedHarness: false, movingTransition: false, sessionModel, profileModel, preferred }), sessionModel);
  assert.equal(nextTurnModelRef({ stagedHarness: false, movingTransition: false, profileModel, preferred }), profileModel);
  assert.equal(nextTurnModelRef({ stagedHarness: false, movingTransition: false, preferred }), preferred);
  // A staged harness leaves the chat's model behind with its old route.
  assert.equal(nextTurnModelRef({ stagedHarness: true, movingTransition: false, sessionModel, preferred }), preferred);
  assert.equal(nextTurnModelRef({ stagedHarness: true, movingTransition: true, sessionModel, preferred }), preferred,
    "a staged harness restates the launch even while a switch is pending");
  // A switch to another harness nobody staged here names nothing: its recorded
  // launch decides, not a look-alike of the old route's model or a default.
  assert.equal(nextTurnModelRef({ stagedHarness: false, movingTransition: true, sessionModel, profileModel, preferred }), undefined);
});

test("the composer offers the last chosen model on a harness switch and records each pick", async () => {
  const { readFile } = await import("node:fs/promises");
  const composer = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  // A route counts as switched for an open chat's staged harness and for a
  // harness chosen in a new chat (rule: `routeSwitchedByPerson`).
  assert.match(composer, /const stagedHarnessId = cfg\.harness\?\.mode === "pinned"\s*\?\s*cfg\.harness\.harnessId/);
  assert.match(composer, /const pendingSessionHarnessId = session \? stagedHarnessId : undefined;/);
  assert.match(composer, /const routeSwitched = routeSwitchedByPerson\(\{\s*hasSession: Boolean\(session\),\s*\.\.\.\(pendingSessionHarnessId \? \{ stagedHarnessId: pendingSessionHarnessId \} : \{\}\),\s*\.\.\.\(session\?\.resolvedHarnessId \? \{ resolvedHarnessId: session\.resolvedHarnessId \} : \{\}\),\s*draftHarnessExplicit: draftRoute\.draft\.harnessSelectionExplicit === true,/);
  // One rule feeds the chip and the send.
  assert.match(composer, /const \{ preferred: preferredModel, route: routeModel \} = routeDefaultModel\(\{\s*models: chatModels,\s*switched: routeSwitched,/);
  // The memory is the remembered chat pick of the harness the route moves to;
  // the unswitched fallback is unchanged.
  assert.match(composer, /const rememberedHarnessModel = catalogHarnessId \? lastHarnessModels\[catalogHarnessId\] : undefined;/);
  assert.match(composer, /lastChosenHarnessModel\(chatModels, isHiddenModel, catalogHarnessId, rememberedHarnessModel\)/);
  assert.match(composer, /const fallbackModel = useMemo\(\(\) => visibleFallbackModel\(/);
  // A staged harness shows the model the send will commit; a server-side
  // transition shows its recorded launch (rule: `composerChipModel`).
  assert.match(composer, /const movingTransition = routeMovingTransition\(session\?\.harnessTransition, session\?\.resolvedHarnessId\);/);
  assert.match(composer, /const chipRoute = \{\s*stagedHarness: Boolean\(cfg\.harness\),\s*\.\.\.\(movingTransition \? \{ movingTransition \} : \{\}\),/);
  assert.match(composer, /const recommendedModel = composerChipModel\(\{\s*\.\.\.chipRoute,\s*\.\.\.\(pendingRouteModel \? \{ pendingRouteModel \} : \{\}\),\s*\}\);/);
  // The earlier route's label gives way only to a model the chip can name.
  assert.match(composer, /&& !session\?\.model\s*&& !composerChipModel\(chipRoute\)/);
  // The remembered name stands in only while the target catalogue loads.
  assert.match(composer, /routeSwitched && !cfg\.model && modelCatalog\.state === "loading"/);
  // The effort control, the send and a steered queue item name the same next
  // turn model (rule: `nextTurnModelRef`).
  assert.match(composer, /const nextTurn = nextTurnModelRef\(\{\s*\.\.\.\(cfg\.model \? \{ configModel: cfg\.model \} : \{\}\),\s*stagedHarness: Boolean\(cfg\.harness\),\s*movingTransition: Boolean\(movingTransition\),/);
  const sendSites = composer.match(/const selected = nextTurnModelRef\(\{\s*\.\.\.\(cfgSent\.model \? \{ configModel: cfgSent\.model \} : \{\}\),\s*stagedHarness: Boolean\(cfgSent\.harness\),\s*movingTransition: Boolean\(routeMovingTransition\(session\?\.harnessTransition, session\?\.resolvedHarnessId\)\),/g) ?? [];
  assert.equal(sendSites.length, 2, "submit and steer resolve the model alike");
  // Only an explicit chat pick becomes a harness's memory.
  assert.match(composer, /rememberHarnessModel\(descriptor\.harnessId \?\? selectedCatalogHarnessId \?\? "opencode", \{/);
  // The rate-limit picker's harness tabs follow the same memory.
  const timeline = await readFile(new URL("../src/components/Timeline.tsx", import.meta.url), "utf8");
  assert.match(timeline, /recommended=\{recommendedModel\}/);
  assert.match(timeline, /lastChosenHarnessModel\(\s*routeCatalog\.models,/);
  assert.match(timeline, /const rememberedModel = otherHarness && catalogHarnessId/);
  assert.match(timeline, /rememberHarnessModel\(catalogHarnessId, \{/);
});
