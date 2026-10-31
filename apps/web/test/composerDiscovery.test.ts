// Pure gates: four-state catalog truth, safe token
// insertion, stable autocomplete ids + honest status copy, contract-bounded
// model detail, and the per-session execution configuration record.
// DOM-free (localStorage shimmed).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SlashCommand, SnippetDef, StrictListResult } from "@polyth/session/web-api";
import { tr } from "../src/i18n/index.ts";

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const {
  ATTACHMENT_COMPAT_NOTE, CATALOG_LOADING, OPEN_PROJECT_FIRST,
  SHELL_DRAFT_BLOCK, addMenuRows, autocompleteOptionId, catalogFromResult,
  commandAutocomplete, commandPrecedence, contextTokensLabel, fileAutocomplete, groupAutocompleteOptions, mergeCommandCatalog, modelDetail,
  modelDisplayName, modelSupportsTextWorkflow, planCommandInsert, planShellEntry,
  nativeCommandInput, planSigilInsert, snippetAutocomplete,
} = await import("../src/composer/discovery.ts");
const { activeToken, composerMode } = await import("../src/composer/language.ts");
const {
  configEquals, consumeComposerConfig, emptyComposerConfig, isDefaultComposerConfig,
  loadComposerConfig, parseComposerConfig, saveComposerConfig, serializeComposerConfig,
  wireProfileId, withAutoThinking, withExplicitAgent, withExplicitModel, withExplicitThinking,
  withDraftHarnessForNextTurn, withHarnessForNextTurn, withModelForNextTurn, withProfile, withProfileNone,
} = await import("../src/composerConfig.ts");

const cmd = (name: string, description = `${name} desc`): SlashCommand =>
  ({ name, description, prompt: "p", scope: "project" });
const snip = (alias: string): SnippetDef => ({ alias, text: `${alias} body`, scope: "project" });

// ---------------------------------------------------------------- catalogs

test("catalog: loading, successful empty, failure, and absent project stay distinct", () => {
  assert.deepEqual(catalogFromResult(null), { state: "loading" });
  assert.equal(CATALOG_LOADING.state, "loading");
  const empty: StrictListResult<SlashCommand> = { ok: true, items: [] };
  assert.deepEqual(catalogFromResult(empty), { state: "empty" });
  const failed: StrictListResult<SlashCommand> = { ok: false, reason: "HTTP 500" };
  assert.deepEqual(catalogFromResult(failed), { state: "unavailable", reason: "HTTP 500" });
  const ok: StrictListResult<SlashCommand> = { ok: true, items: [cmd("plan")] };
  const r = catalogFromResult(ok);
  assert.equal(r.state, "available");
  assert.equal(r.state === "available" && r.items.length, 1);
  // a failed request is NEVER presented as a successful empty list
  assert.notDeepEqual(catalogFromResult(failed), catalogFromResult(empty));
});

test("catalog: command and snippet outcomes are independent shapes", () => {
  // one failing and one succeeding never collapse into a shared empty state
  const commands = catalogFromResult<SlashCommand>({ ok: false, reason: "boom" });
  const snippets = catalogFromResult<SnippetDef>({ ok: true, items: [] });
  assert.equal(commands.state, "unavailable");
  assert.equal(snippets.state, "empty");
});

// ---------------------------------------------------------------- insertion

test("@ / # insert at the caret with required whitespace and an active token", () => {
  // empty draft: bare sigil, caret right after it
  assert.deepEqual(planSigilInsert("", 0, "@"), { text: "@", caret: 1 });
  // caret touching a word gains a separating space
  const mid = planSigilInsert("look at", 7, "@");
  assert.equal(mid.text, "look at @");
  assert.equal(mid.caret, 9);
  // caret touching following prose never absorbs it into the token
  const split = planSigilInsert("beforeafter", 6, "#");
  assert.equal(split.text, "before # after".replace(" # ", " # ")); // literal check below
  assert.equal(split.text, "before # after");
  assert.equal(split.text[split.caret - 1], "#");
  // the grammar recognizes the inserted sigil as an active token at the caret
  for (const sigil of ["@", "#"] as const) {
    const plan = planSigilInsert("draft text", 5, sigil);
    const token = activeToken(plan.text, plan.caret);
    assert.ok(token, `${sigil} token active at caret`);
  }
});

test("/ inserts only at a valid line start, never an inert mid-line slash", () => {
  assert.deepEqual(planCommandInsert("", 0), { text: "/", caret: 1 });
  // nonempty content: newline first
  const after = planCommandInsert("existing draft", 14);
  assert.equal(after.text, "existing draft\n/");
  assert.equal(after.caret, 16);
  // caret splitting a line: newline on both sides
  const middle = planCommandInsert("one two", 3);
  assert.equal(middle.text, "one\n/\n two".replace("\n/\n two", "\n/\n two"));
  assert.equal(middle.text, "one\n/\n two");
  // every plan yields a recognized command token at the caret
  for (const [textIn, caretIn] of [["", 0], ["draft", 5], ["a\nb", 1]] as const) {
    const plan = planCommandInsert(textIn, caretIn);
    const token = activeToken(plan.text, plan.caret);
    assert.equal(token?.kind, "command", `command token for ${JSON.stringify(textIn)}`);
  }
});

test("shell entry never reinterprets a nonempty prompt draft", () => {
  assert.deepEqual(planShellEntry(""), { ok: true, text: "!", caret: 1 });
  assert.deepEqual(planShellEntry("   \n "), { ok: true, text: "!", caret: 1 });
  const blocked = planShellEntry("deploy the app");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.reason, SHELL_DRAFT_BLOCK);
  // and the successful plan actually is shell mode in the grammar
  assert.equal(composerMode("!"), "shell");
});

// ---------------------------------------------------------------- Add menu

test("add menu: exact rows, contributed items in order, sigil hints, and no Skills/Variant", () => {
  const rows = addMenuRows({
    hasProject: true, hasSession: true, draftText: "",
    commands: { state: "available", items: [cmd("a"), cmd("b")] },
    snippets: { state: "empty" },
    // The host registry hands contributions over already sorted by order.
    contributions: [
      { id: "github.link", label: "Link GitHub issue or pull request…", description: "Adds a link only", order: 10 },
      { id: "goals.attach", label: "Attach goal", order: 20 },
    ],
  });
  assert.deepEqual(rows.map((r) => r.label), [
    tr("composer.discovery.photos"),
    tr("composer.files"),
    tr("composer.discovery.addContext"),
    tr("composer.discovery.mentionProjectFile"),
    "Link GitHub issue or pull request…",
    "Attach goal",
    tr("composer.discovery.compose"),
    tr("composer.discovery.commands"),
    tr("composer.discovery.snippets"),
    tr("composer.discovery.shellCommand"),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Attach sources are tiles and appear nowhere else in the list.
  assert.deepEqual(rows.filter((r) => r.tile).map((r) => r.id), ["photos", "upload"]);
  assert.equal(byId.get("upload")?.description, tr("composer.discovery.uploadFiles"));
  assert.equal(byId.get("photos")?.description, tr("composer.discovery.choosePhotos"));
  assert.equal(new Set(rows.map((r) => r.action).filter(Boolean)).size,
    rows.filter((r) => r.action).length, "no host action is offered twice");
  // Contributed rows keep their package identity and never borrow a host action.
  assert.equal(byId.get("contribution:github.link")?.contributionId, "github.link");
  assert.equal(byId.get("contribution:github.link")?.action, undefined);
  assert.equal(byId.get("contribution:github.link")?.description, "Adds a link only");
  assert.equal(byId.get("contribution:goals.attach")?.contributionId, "goals.attach");
  assert.equal(byId.get("mention")?.hint, "@");
  assert.equal(byId.get("commands")?.hint, "/");
  assert.equal(byId.get("snippets")?.hint, "#");
  assert.equal(byId.get("shell")?.hint, "!");
  assert.equal(byId.get("shell")?.description, tr("composer.discovery.permissionCheckedOutputIsAddedToContext"));
  assert.equal(byId.get("commands")?.detail, tr("composer.discovery.valueAvailable", { value: 2 }));
  assert.equal(byId.get("snippets")?.detail, tr("composer.discovery.noSnippetsYet"));
  // capability honesty: nothing advertises Skills or a model Variant
  const all = JSON.stringify(rows).toLowerCase();
  assert.ok(!all.includes("skill"));
  assert.ok(!all.includes("variant"));
});

test("add menu: visible disabled reasons for a missing project and a drafted shell", () => {
  const noProject = addMenuRows({
    hasProject: false, hasSession: false, draftText: "",
    commands: { state: "loading" }, snippets: { state: "loading" },
  });
  for (const id of ["photos", "upload", "mention", "commands", "snippets", "shell"]) {
    assert.equal(noProject.find((r) => r.id === id)?.disabledReason, OPEN_PROJECT_FIRST, id);
  }
  // No registry contribution supplies these rows; the host never invents them.
  assert.equal(noProject.find((r) => r.id === "contribution:github.link"), undefined);

  const drafted = addMenuRows({
    hasProject: true, hasSession: true, draftText: "already typed",
    commands: { state: "empty" }, snippets: { state: "unavailable", reason: "x" },
  });
  assert.equal(drafted.find((r) => r.id === "shell")?.disabledReason, SHELL_DRAFT_BLOCK);
  assert.equal(drafted.find((r) => r.id === "contribution:goals.attach"), undefined); // no contribution registered
  assert.equal(drafted.find((r) => r.id === "commands")?.detail, tr("composer.discovery.noCommandsAvailable"));
  assert.equal(drafted.find((r) => r.id === "snippets")?.detail, tr("composer.discovery.currentlyUnavailable"));
});

test("add menu: camera leads the attach tiles only where a camera can open", () => {
  const base = {
    hasProject: true, hasSession: true, draftText: "",
    commands: { state: "empty" as const }, snippets: { state: "empty" as const },
  };
  assert.equal(addMenuRows(base).find((r) => r.id === "camera"), undefined, "desktop offers no camera");
  const touch = addMenuRows({ ...base, canCapturePhoto: true });
  assert.deepEqual(touch.filter((r) => r.tile).map((r) => r.action), ["camera", "photos", "upload"]);
  assert.equal(touch.find((r) => r.id === "camera")?.description, tr("composer.discovery.takePhoto"));
  // One upload block disables every attach source together.
  const blocked = addMenuRows({ ...base, canCapturePhoto: true, uploadDisabledReason: "Read-only" });
  assert.deepEqual(blocked.filter((r) => r.tile).map((r) => r.disabledReason), ["Read-only", "Read-only", "Read-only"]);
});

// ---------------------------------------------------------------- autocomplete

test("option ids derive from token kind + identity, never the array index", () => {
  const a = autocompleteOptionId("cmd", "plan");
  const b = autocompleteOptionId("snip", "plan");
  assert.notEqual(a, b); // same identity, different kind
  assert.match(a, /^[A-Za-z][\w-]*$/); // DOM-id safe
  assert.equal(autocompleteOptionId("file", "src/a b.ts"), autocompleteOptionId("file", "src/a b.ts"));
  // reordering the catalog must not change an item's id
  const catalog = { state: "available" as const, items: [cmd("alpha"), cmd("beta")] };
  const flipped = { state: "available" as const, items: [cmd("beta"), cmd("alpha")] };
  const idsA = commandAutocomplete(catalog, "").options.map((o) => [o.label, o.id] as const);
  const idsB = new Map(commandAutocomplete(flipped, "").options.map((o) => [o.label, o.id] as const));
  for (const [label, id] of idsA) assert.equal(idsB.get(label), id);
});

test("command autocomplete states carry the exact honest copy", () => {
  assert.equal(commandAutocomplete({ state: "loading" }, "").status?.text, tr("composer.discovery.loadingCommands"));
  assert.equal(
    commandAutocomplete({ state: "unavailable", reason: "500" }, "").status?.text,
    tr("composer.discovery.commandsUnavailable"),
  );
  assert.equal(commandAutocomplete({ state: "empty" }, "").status?.text, tr("composer.discovery.noCommandsAvailable"));
  const avail = { state: "available" as const, items: [cmd("plan")] };
  assert.equal(commandAutocomplete(avail, "zz").status?.text, tr("composer.discovery.noCommandsMatch", { query: "zz" }));
  const hit = commandAutocomplete(avail, "pl");
  assert.equal(hit.status, null);
  assert.equal(hit.options[0]?.label, "/plan");
});

test("command autocomplete separates kind, provenance, and Settings destinations", () => {
  const skill: SlashCommand = {
    ...cmd("repo-check", "Check repository conventions"),
    id: "skill:repo-check",
    scope: "builtin",
    owner: "builtin",
    kind: "skill",
    skillScope: "project-agents",
  };
  const extension: SlashCommand = {
    ...cmd("capture", "Capture the current context"),
    id: "extension:example-tools:capture",
    scope: "builtin",
    owner: "builtin",
  };
  const native = {
    id: "native:claude:compact",
    name: "compact",
    description: "Compact native context",
    owner: "native" as const,
    harnessId: "claude",
    invocation: "raw-native-input" as const,
    argumentHint: "focus",
  };
  const view = commandAutocomplete({
    state: "available",
    items: [skill, extension, native, { ...cmd("plan"), scope: "user" as const }],
  }, "");

  assert.equal(view.resultCount, 4, "Settings destinations are not counted as runnable actions");
  const groups = groupAutocompleteOptions(view.options);
  assert.deepEqual(groups.map((group) => group.id), ["project", "personal", "plugins", "agent", "customize"]);
  const skillOption = view.options.find((option) => option.label === "/repo-check")!;
  assert.equal(skillOption.presentation?.kind, "skill");
  assert.equal(skillOption.presentation?.groupId, "project");
  assert.equal(skillOption.presentation?.sourceLabel, ".agents");
  const nativeOption = view.options.find((option) => option.label === "/compact")!;
  assert.equal(nativeOption.presentation?.sourceLabel, "Claude");
  assert.equal(nativeOption.argumentHint, "focus");
  assert.deepEqual(
    view.options.filter((option) => option.destination).map((option) => option.destination?.pageId),
    ["commands", "skills", "behavior"],
  );
});

test("action search matches type and management keywords without inventing runnable rules", () => {
  const skill: SlashCommand = {
    ...cmd("browser-control"),
    id: "skill:browser-control",
    scope: "builtin",
    kind: "skill",
    skillScope: "space",
  };
  const skills = commandAutocomplete({ state: "available", items: [skill, cmd("review")] }, "skill");
  assert.deepEqual(skills.options.map((option) => option.label), ["/browser-control", tr("starters.skills2")]);
  const rules = commandAutocomplete({ state: "available", items: [skill] }, "rules");
  assert.equal(rules.resultCount, 0);
  assert.deepEqual(rules.options.map((option) => option.destination?.pageId), ["behavior"]);
  assert.equal(rules.options.some((option) => option.command), false, "behavior rules stay automatic, not slash commands");
});

test("native command merge preserves colliding rows, exact ids, and Polyth precedence", () => {
  const polyth = [
    { ...cmd("review"), id: "polyth:project:review", owner: "project" as const },
  ];
  const native = [{
    id: "native:codex:review",
    name: "review",
    description: "Native review",
    owner: "native" as const,
    harnessId: "codex",
    invocation: "raw-native-input" as const,
  }];
  const merged = mergeCommandCatalog(polyth, native);
  const options = commandAutocomplete({ state: "available", items: merged }, "review").options;
  assert.equal(options.length, 2);
  assert.equal(new Set(options.map((option) => option.id)).size, 2);
  assert.deepEqual(options.map((option) => option.command?.id), [
    "polyth:project:review",
    "native:codex:review",
  ]);
  assert.equal(commandPrecedence("review", merged), polyth[0]);
  assert.equal(commandPrecedence("native-only", mergeCommandCatalog([], [{
    ...native[0]!,
    id: "native:codex:native-only",
    name: "native-only",
  }]))?.id, "native:codex:native-only");
  assert.equal(nativeCommandInput("/review src", merged), undefined, "typed collision keeps project precedence");
  assert.deepEqual(nativeCommandInput("/review src", merged, native[0]), {
    id: "native:codex:review",
    args: "src",
  });
});

test("native private skill names use stable slash aliases end to end", () => {
  const native = {
    id: "native:claude:polyth-private:repo-check-123",
    name: "polyth-private:repo-check-123",
    aliases: ["repo-check"],
    description: "Native skill",
    owner: "native" as const,
    harnessId: "claude",
    invocation: "raw-native-input" as const,
  };
  const catalog = mergeCommandCatalog([], [native]);
  const option = commandAutocomplete({ state: "available", items: catalog }, "repo-check").options[0];
  assert.equal(option?.label, "/repo-check");
  assert.equal(option?.value, "/repo-check ");
  assert.deepEqual(nativeCommandInput("/repo-check src", catalog, native), {
    id: native.id,
    args: "src",
  });
});

test("nativeCommandInput clears stale selection when the edited token no longer matches", () => {
  const native = [{
    id: "native:codex:review",
    name: "review",
    owner: "native" as const,
    harnessId: "codex",
    invocation: "raw-native-input" as const,
  }, {
    id: "native:codex:other",
    name: "other",
    owner: "native" as const,
    harnessId: "codex",
    invocation: "raw-native-input" as const,
  }];
  const catalog = mergeCommandCatalog([], native);
  assert.deepEqual(nativeCommandInput("/other args", catalog, native[0]), {
    id: "native:codex:other",
    args: "args",
  });
});

test("snippet autocomplete: empty state offers snippet creation; failure does not", () => {
  const empty = snippetAutocomplete({ state: "empty" }, "");
  assert.equal(empty.status?.text, tr("composer.discovery.noSnippetsYet"));
  assert.equal(empty.status?.createSnippet, true);
  const down = snippetAutocomplete({ state: "unavailable", reason: "x" }, "");
  assert.equal(down.status?.text, tr("composer.discovery.snippetsUnavailable"));
  assert.ok(!down.status?.createSnippet);
  assert.equal(snippetAutocomplete({ state: "loading" }, "").status?.text, tr("composer.discovery.loadingSnippets"));
  const avail = { state: "available" as const, items: [snip("sig")] };
  assert.equal(snippetAutocomplete(avail, "zz").status?.text, tr("composer.discovery.noSnippetsMatch", { query: "zz" }));
  assert.equal(snippetAutocomplete(avail, "si").options[0]?.label, "#sig");
});

test("file autocomplete: instruction, pending, empty, and results are distinct", () => {
  assert.equal(
    fileAutocomplete("", "done", []).status?.text,
    tr("composer.discovery.typeFileOrFolder"),
  );
  assert.equal(fileAutocomplete("src", "pending", []).status?.text, tr("composer.discovery.searchingProjectFiles"));
  assert.equal(fileAutocomplete("zz", "done", []).status?.text, tr("composer.discovery.noProjectFilesMatch", { query: "zz" }));
  const hits = fileAutocomplete("a", "done", [
    { path: "src/app.ts", kind: "file" }, { path: "src", kind: "dir" },
  ]);
  assert.equal(hits.status, null);
  assert.deepEqual(hits.options.map((o) => o.value), ["@src/app.ts ", "@src/"]);
  // stale-guard support: a pending phase never exposes previous hits
  assert.equal(fileAutocomplete("ap", "pending", []).options.length, 0);
});

// ---------------------------------------------------------------- model truth

test("model detail renders only contract-supplied fields — no cost/modality/variant", () => {
  assert.equal(contextTokensLabel(undefined), null);
  assert.equal(contextTokensLabel("128k"), null); // non-numeric never rendered
  assert.equal(contextTokensLabel(0), null);
  assert.equal(contextTokensLabel(128_000), tr("modelpicker.valueKContext", { value: 128 }));
  assert.equal(contextTokensLabel(600), tr("modelpicker.valueContext", { value: 600 }));
  const full = modelDetail({ providerID: "anthropic", providerName: "Anthropic", context: 200_000, connected: false });
  assert.equal(full, `Anthropic · ${tr("modelpicker.valueKContext", { value: 200 })} · ${tr("settings.modelspage.notConnected")}`);
  const bare = modelDetail({ providerID: "openai" });
  assert.equal(bare, "openai");
  // absent/undefined fields never turn into claims
  for (const detail of [full, bare]) {
    const low = detail.toLowerCase();
    for (const banned of ["$", "cost", "image", "vision", "modal", "variant", "attach"]) {
      assert.ok(!low.includes(banned), `${detail} must not claim ${banned}`);
    }
  }
  assert.equal(ATTACHMENT_COMPAT_NOTE, tr("composer.discovery.attachmentCompatibilityNotReported"));
});

test("text workflows reject reported non-text modalities and distinguish duplicate names", () => {
  assert.equal(modelSupportsTextWorkflow({}), true, "legacy catalogs without modality metadata remain usable");
  assert.equal(modelSupportsTextWorkflow({ capabilities: ["input:text", "output:text", "toolcall"] }), true);
  assert.equal(modelSupportsTextWorkflow({ capabilities: ["input:text", "output:image"] }), false);
  assert.equal(modelSupportsTextWorkflow({ capabilities: ["input:audio", "output:text"] }), false);
  assert.equal(modelSupportsTextWorkflow({ capabilities: ["input:text", "output:none"] }), false);

  const catalog = [
    { providerID: "google", modelID: "nano-v1", name: "Nano Banana" },
    { providerID: "vertex", modelID: "nano-v2-preview", name: "  nano   banana  " },
    { providerID: "openai", modelID: "gpt", name: "GPT" },
  ];
  assert.equal(modelDisplayName(catalog[0]!, catalog), "Nano Banana · google/nano-v1");
  assert.equal(modelDisplayName(catalog[1]!, catalog), "nano   banana · vertex/nano-v2-preview");
  assert.equal(modelDisplayName(catalog[2]!, catalog), "GPT");
});

// ---------------------------------------------------------------- configuration

test("composer config: versioned parse/serialize round-trip and corruption safety", () => {
  const cfg = withExplicitAgent(
    withExplicitModel(emptyComposerConfig(), { harnessId: "acp", providerID: "p", modelID: "m" }),
    "builder",
  );
  const parsed = parseComposerConfig(serializeComposerConfig(cfg));
  assert.ok(configEquals(parsed, cfg));
  assert.equal(parsed.model?.harnessId, "acp");
  assert.deepEqual(parsed.harness, { mode: "pinned", harnessId: "acp" });
  assert.deepEqual(parseComposerConfig(null), emptyComposerConfig());
  assert.deepEqual(parseComposerConfig("not json"), emptyComposerConfig());
  assert.deepEqual(parseComposerConfig('{"v":2,"profile":"x"}'), emptyComposerConfig());
  assert.equal(parseComposerConfig('{"v":1,"profile":null,"harness":{"mode":"pinned","harnessId":"../bad"}}').harness, undefined);
  assert.ok(isDefaultComposerConfig(emptyComposerConfig()));
  assert.ok(!isDefaultComposerConfig(cfg));
});

test("profile selection and explicit overrides clear each other", () => {
  // selecting a profile clears explicit model + agent
  const overridden = withExplicitAgent(
    withExplicitModel(emptyComposerConfig(), { providerID: "p", modelID: "m" }),
    "builder",
  );
  const profiled = withProfile(overridden, "prof-1");
  assert.deepEqual(profiled, { profile: { kind: "id", id: "prof-1" } });
  // an explicit model clears the selected profile (never claims the bundle)
  const modelAfter = withExplicitModel(profiled, { providerID: "q", modelID: "n" });
  assert.equal(modelAfter.profile.kind, "none");
  assert.deepEqual(modelAfter.model, { providerID: "q", modelID: "n" });
  // an explicit agent clears it too
  const agentAfter = withExplicitAgent(withProfile(emptyComposerConfig(), "prof-2"), "coder");
  assert.equal(agentAfter.profile.kind, "none");
  assert.equal(agentAfter.agent, "coder");
  // None clears only the profile selection; overrides survive
  const noneKeeps = withProfileNone(overridden);
  assert.equal(noneKeeps.profile.kind, "none");
  assert.deepEqual(noneKeeps.model, { providerID: "p", modelID: "m" });
  assert.equal(noneKeeps.agent, "builder");
  // clearing the model override keeps the profile choice
  const cleared = withExplicitModel(profiled, undefined);
  assert.deepEqual(cleared.profile, { kind: "id", id: "prof-1" });
});

test("agent switches preserve effort; model switches clear only the pending effort", () => {
  const configured = withExplicitThinking(
    withExplicitModel(emptyComposerConfig(), { providerID: "p", modelID: "reasoning" }),
    "high",
  );
  const nextAgent = withExplicitAgent(configured, "review");
  assert.equal(nextAgent.thinking, "high", "effort belongs to the current model, not the agent");

  const nextModel = withModelForNextTurn(nextAgent, { providerID: "p", modelID: "plain" });
  assert.equal(nextModel.thinking, undefined, "a model switch cannot carry an incompatible pending effort");
  assert.equal(nextModel.agent, "review", "model and agent choices stay independent");
});

test("staging a harness clears incompatible runtime choices without switching the active route", () => {
  const configured = withExplicitThinking({
    profile: { kind: "inherit" },
    model: { harnessId: "opencode", providerID: "openai", modelID: "shared" },
    agent: "build",
  }, "high");
  const staged = withHarnessForNextTurn(
    configured,
    { mode: "pinned", harnessId: "codex" },
    { harnessId: "opencode", profileId: "profile-open" },
    [{ id: "profile-open", harnessId: "opencode" }],
  );
  assert.deepEqual(staged, {
    profile: { kind: "none" },
    harness: { mode: "pinned", harnessId: "codex" },
  });

  const returned = withHarnessForNextTurn(
    staged,
    { mode: "pinned", harnessId: "opencode" },
    { harnessId: "opencode" },
    [],
  );
  assert.equal(returned.harness, undefined, "choosing the live route cancels the staged switch");
});

test("a new-session harness switch clears the old controlled model in the same transition", () => {
  const switched = withDraftHarnessForNextTurn({
    harnessSelection: { mode: "pinned", harnessId: "codex" },
    harnessSelectionExplicit: true,
    model: { harnessId: "codex", providerID: "openai", modelID: "gpt-6-astra" },
    agent: { harnessId: "codex", agent: "review" },
    profileId: "codex-profile",
    thinking: "high",
    mode: "plan",
    features: { tools: true },
  }, { mode: "pinned", harnessId: "claude" }, [
    { id: "codex-profile", harnessId: "codex" },
  ]);

  assert.deepEqual(switched, {
    harnessSelection: { mode: "pinned", harnessId: "claude" },
    harnessSelectionExplicit: true,
    mode: "plan",
    features: { tools: true },
  });
});

test("Auto is explicit and survives persistence as a distinct choice", () => {
  const configured = withExplicitThinking(
    withExplicitModel(emptyComposerConfig(), { providerID: "p", modelID: "reasoning" }),
    "high",
  );
  const auto = withAutoThinking(configured);
  assert.equal(auto.thinking, null);
  assert.ok(!isDefaultComposerConfig(auto));
  assert.equal(parseComposerConfig(serializeComposerConfig(auto)).thinking, null);
});

test("wire profile id: selected, explicit None, and inherited never conflate", () => {
  assert.equal(wireProfileId(withProfile(emptyComposerConfig(), "prof-1")), "prof-1");
  assert.equal(wireProfileId(withProfileNone(emptyComposerConfig())), null);
  assert.equal(wireProfileId(emptyComposerConfig()), undefined);
});

test("config storage: per-session keys survive switches and never cross", () => {
  mem.clear();
  const a = withProfile(emptyComposerConfig(), "prof-a");
  const b = withExplicitModel(emptyComposerConfig(), { providerID: "p", modelID: "m" });
  saveComposerConfig("sess-a", a);
  saveComposerConfig("sess-b", b);
  saveComposerConfig(null, withExplicitAgent(emptyComposerConfig(), "hero-agent"));
  // reload restores each session's own exact state
  assert.ok(configEquals(loadComposerConfig("sess-a"), a));
  assert.ok(configEquals(loadComposerConfig("sess-b"), b));
  assert.equal(loadComposerConfig(null).agent, "hero-agent");
  assert.ok(configEquals(loadComposerConfig("sess-untouched"), emptyComposerConfig()));
  // a default record is removed, not stored
  saveComposerConfig("sess-a", emptyComposerConfig());
  assert.equal(mem.has("polyth.composer.config.v1.sess-a"), false);
});

test("consume after send removes the record only when it still equals what was sent", () => {
  mem.clear();
  const sent = withProfile(emptyComposerConfig(), "prof-a");
  saveComposerConfig("sess-a", sent);
  // user changed the pending config after the send left: record survives
  const changed = withProfile(emptyComposerConfig(), "prof-b");
  saveComposerConfig("sess-a", changed);
  consumeComposerConfig("sess-a", sent);
  assert.ok(configEquals(loadComposerConfig("sess-a"), changed));
  // unchanged record is consumed
  consumeComposerConfig("sess-a", changed);
  assert.ok(configEquals(loadComposerConfig("sess-a"), emptyComposerConfig()));

  // A live projection can commit only the route while the same send is still
  // awaiting admission. That is not a newer picker edit.
  const routed = withExplicitModel(emptyComposerConfig(), {
    harnessId: "codex", providerID: "openai", modelID: "gpt",
  });
  saveComposerConfig("sess-a", routed);
  const { harness: _committed, ...afterRouteCommit } = routed;
  saveComposerConfig("sess-a", afterRouteCommit);
  consumeComposerConfig("sess-a", routed);
  assert.ok(configEquals(loadComposerConfig("sess-a"), emptyComposerConfig()));
});
