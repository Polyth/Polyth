// UX-COMPOSER-DISC pure gates: four-state catalog truth, safe token
// insertion, stable autocomplete ids + honest status copy, contract-bounded
// model detail, GitHub link classification, and the per-session execution
// configuration record. DOM-free (localStorage shimmed).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SlashCommand, SnippetDef, StrictListResult } from "../src/api.ts";
import { tr } from "../src/i18n/index.ts";

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const {
  ATTACHMENT_COMPAT_NOTE, CATALOG_LOADING, OPEN_PROJECT_FIRST, OPEN_SESSION_FIRST,
  SHELL_DRAFT_BLOCK, addMenuRows, autocompleteOptionId, catalogFromResult,
  commandAutocomplete, contextTokensLabel, fileAutocomplete, modelDetail,
  modelDisplayName, modelSupportsTextWorkflow, planCommandInsert, planShellEntry,
  planSigilInsert, snippetAutocomplete,
} = await import("../src/composer/discovery.ts");
const { activeToken, composerMode } = await import("../src/composer/language.ts");
const { classifyGithubAttach, parseGithubUrl } = await import("../src/attachments.ts");
const {
  configEquals, consumeComposerConfig, emptyComposerConfig, isDefaultComposerConfig,
  loadComposerConfig, parseComposerConfig, saveComposerConfig, serializeComposerConfig,
  wireProfileId, withExplicitAgent, withExplicitModel, withProfile, withProfileNone,
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

test("add menu: exact rows, order, sigil hints, and no Skills/Variant", () => {
  const rows = addMenuRows({
    hasProject: true, hasSession: true, goalsEnabled: true, draftText: "",
    commands: { state: "available", items: [cmd("a"), cmd("b")] },
    snippets: { state: "empty" },
  });
  assert.deepEqual(rows.map((r) => r.label), [
    tr("composer.discovery.addContext"),
    tr("composer.discovery.uploadFiles"),
    tr("composer.discovery.mentionProjectFile"),
    tr("composer.discovery.linkGithubIssueOrPullRequest"),
    tr("composer.discovery.attachGoal"),
    tr("composer.discovery.compose"),
    tr("composer.discovery.commands"),
    tr("composer.discovery.snippets"),
    tr("composer.discovery.shellCommand"),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get("upload")?.description, tr("composer.discovery.copiesFilesIntoThisProjectSInbox"));
  assert.equal(byId.get("github")?.description, tr("composer.discovery.addsALinkOnly"));
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

test("add menu: visible disabled reasons for missing project/session and drafted shell", () => {
  const noProject = addMenuRows({
    hasProject: false, hasSession: false, goalsEnabled: true, draftText: "",
    commands: { state: "loading" }, snippets: { state: "loading" },
  });
  for (const id of ["upload", "mention", "github", "commands", "snippets", "shell"]) {
    assert.equal(noProject.find((r) => r.id === id)?.disabledReason, OPEN_PROJECT_FIRST, id);
  }
  assert.equal(noProject.find((r) => r.id === "goal")?.disabledReason, OPEN_SESSION_FIRST);

  const drafted = addMenuRows({
    hasProject: true, hasSession: true, goalsEnabled: false, draftText: "already typed",
    commands: { state: "empty" }, snippets: { state: "unavailable", reason: "x" },
  });
  assert.equal(drafted.find((r) => r.id === "shell")?.disabledReason, SHELL_DRAFT_BLOCK);
  assert.equal(drafted.find((r) => r.id === "goal"), undefined); // plugin off: row absent
  assert.equal(drafted.find((r) => r.id === "commands")?.detail, tr("composer.discovery.noCommandsAvailable"));
  assert.equal(drafted.find((r) => r.id === "snippets")?.detail, tr("composer.discovery.currentlyUnavailable"));
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

// ---------------------------------------------------------------- GitHub links

test("github classification separates invalid, no-repo, mismatch, failure, and match", () => {
  const repo = { ok: true as const, repo: { owner: "acme", name: "app" } };
  assert.equal(classifyGithubAttach(null, repo).code, "invalid-url");
  const issue = parseGithubUrl("https://github.com/acme/app/issues/12");
  const pr = parseGithubUrl("https://github.com/acme/app/pull/9");
  assert.ok(issue && pr);
  assert.equal(classifyGithubAttach(issue, repo).code, "ok");
  assert.equal(classifyGithubAttach(pr, repo).code, "ok");
  const other = parseGithubUrl("https://github.com/oss/lib/issues/3");
  const mismatch = classifyGithubAttach(other!, repo);
  assert.equal(mismatch.code, "repo-mismatch");
  assert.match(mismatch.code === "repo-mismatch" ? mismatch.reason : "", /oss\/lib/);
  const noRepo = classifyGithubAttach(issue!, { ok: true, repo: null });
  assert.equal(noRepo.code, "no-repo");
  const failed = classifyGithubAttach(issue!, { ok: false, reason: "socket hang up" });
  assert.equal(failed.code, "request-failed");
  assert.match(failed.code === "request-failed" ? failed.reason : "", /socket hang up/);
  // a probe failure is never conflated with a mismatch or missing repo
  assert.notEqual(failed.code, noRepo.code);
});

// ---------------------------------------------------------------- configuration

test("composer config: versioned parse/serialize round-trip and corruption safety", () => {
  const cfg = withExplicitAgent(
    withExplicitModel(emptyComposerConfig(), { providerID: "p", modelID: "m" }),
    "builder",
  );
  const parsed = parseComposerConfig(serializeComposerConfig(cfg));
  assert.ok(configEquals(parsed, cfg));
  assert.deepEqual(parseComposerConfig(null), emptyComposerConfig());
  assert.deepEqual(parseComposerConfig("not json"), emptyComposerConfig());
  assert.deepEqual(parseComposerConfig('{"v":2,"profile":"x"}'), emptyComposerConfig());
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
});
