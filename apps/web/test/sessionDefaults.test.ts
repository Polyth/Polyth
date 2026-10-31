import test from "node:test";
import assert from "node:assert/strict";
import { projectIsolatesByDefault, projectIsolationLevel } from "@polyth/contracts";
import {
  parseSessionDefaults,
  projectRemembersModelSelection,
  resolveProjectModelDefault,
  resolveSessionDefaultModel,
} from "../src/sessionDefaults.ts";
import {
  parseThinkingPrefs,
  serializeThinkingPrefs,
  thinkingModelKey,
} from "@polyth/models/web-prefs";

const project = { providerID: "anthropic", modelID: "claude-project" };
const global = { providerID: "openai", modelID: "gpt-global" };

test("session model defaults resolve project before global before undefined", () => {
  assert.deepEqual(resolveSessionDefaultModel(project, global), project);
  assert.deepEqual(resolveSessionDefaultModel(null, global), global);
  assert.deepEqual(resolveSessionDefaultModel(undefined, global), global);
  assert.deepEqual(resolveSessionDefaultModel(undefined, undefined, project), project);
  assert.equal(resolveSessionDefaultModel(null, undefined), undefined);
  assert.equal(resolveSessionDefaultModel(undefined, undefined), undefined);
});

test("project model memory honors the toggle and existing saved defaults", () => {
  assert.equal(projectRemembersModelSelection(), false);
  assert.equal(projectRemembersModelSelection({ model: project }), true);
  assert.equal(projectRemembersModelSelection({
    model: project,
    rememberModelSelection: false,
  }), false);

  assert.deepEqual(resolveProjectModelDefault({ model: project }, global), project);
  assert.deepEqual(resolveProjectModelDefault({
    model: project,
    rememberModelSelection: false,
  }, global), global);
  assert.deepEqual(resolveProjectModelDefault({
    rememberModelSelection: true,
  }, undefined, global), global);
});

test("session defaults parser accepts only complete model references", () => {
  assert.deepEqual(parseSessionDefaults(JSON.stringify({ defaultModel: global })), {
    defaultModel: global,
  });
  assert.deepEqual(parseSessionDefaults(null), {});
  assert.deepEqual(parseSessionDefaults("not json"), {});
  assert.deepEqual(parseSessionDefaults('{"defaultModel":{"providerID":"openai"}}'), {});
  assert.deepEqual(parseSessionDefaults('{"defaultModel":{"providerID":"","modelID":"gpt"}}'), {});
  assert.deepEqual(parseSessionDefaults(JSON.stringify({ retentionAction: "delete", archiveRetentionDays: 90 })), {
    retentionAction: "delete",
    archiveRetentionDays: 90,
  });
});

test("thinking preferences are model-scoped, corruption-safe, and deterministic", () => {
  const gpt = { providerID: "openai", modelID: "gpt-5" };
  const claude = { providerID: "anthropic", modelID: "claude-4" };
  assert.equal(thinkingModelKey(gpt), "local/openai/gpt-5");
  assert.deepEqual(parseThinkingPrefs('{"openai/gpt-5":"high","bad":3,"":"low"}'), {
    "openai/gpt-5": "high",
  });
  assert.deepEqual(parseThinkingPrefs("not json"), {});
  assert.equal(
    serializeThinkingPrefs({ [thinkingModelKey(gpt)]: "high", [thinkingModelKey(claude)]: "low" }),
    '{"local/anthropic/claude-4":"low","local/openai/gpt-5":"high"}',
  );
});

test("session defaults preserve an aggregated catalog's harness identity", () => {
  const selected = { harnessId: "cursor", providerID: "cursor", modelID: "same" };
  assert.deepEqual(parseSessionDefaults(JSON.stringify({ defaultModel: selected })), {
    defaultModel: selected,
  });
});

test("a stored global isolate default is ignored: isolation is a project setting", () => {
  assert.equal("isolateByDefault" in parseSessionDefaults(JSON.stringify({ isolateByDefault: true })), false);
});

test("project isolation is off unless the project opts in", () => {
  assert.equal(projectIsolationLevel(undefined), "off");
  assert.equal(projectIsolationLevel({}), "off");
  assert.equal(projectIsolatesByDefault({ isolateByDefault: true }), false);
  assert.equal(projectIsolationLevel({ isolation: "workspace" }), "workspace");
  assert.equal(projectIsolatesByDefault({ isolation: "workspace" }), false);
  assert.equal(projectIsolatesByDefault({ isolation: "workspace", isolateByDefault: true }), true);
  // The legacy fresh-worktree behavior implied isolation; an explicit off wins.
  assert.equal(projectIsolatesByDefault({ worktreeBehavior: "fresh-worktree" }), true);
  assert.equal(projectIsolationLevel({ worktreeBehavior: "fresh-worktree", isolation: "off" }), "off");
});

// The catalog's first model is only the fallback: backend-opencode orders a
// configured paid provider ahead of OpenCode's free tier, but an explicit
// user or project default always wins over whatever leads the catalog.
test("explicit project and user defaults win over the first available model", () => {
  const firstAvailable = { providerID: "opencode", modelID: "big-pickle", harnessId: "opencode" };
  assert.deepEqual(
    resolveProjectModelDefault({ model: project, rememberModelSelection: true }, global, firstAvailable),
    project,
  );
  assert.deepEqual(resolveProjectModelDefault(undefined, global, firstAvailable), global);
  assert.deepEqual(resolveProjectModelDefault(undefined, undefined, firstAvailable), firstAvailable);
  assert.deepEqual(
    resolveProjectModelDefault({ model: project, rememberModelSelection: false }, undefined, firstAvailable),
    firstAvailable,
    "a project that does not remember its model falls through to the catalog",
  );
});

test("a project's remembered model belongs to its pinned harness only", async () => {
  const { modelIdentityMatches } = await import("../src/composer/discovery.ts");
  const muse = { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" };
  const preferred = resolveProjectModelDefault({ model: muse, harness: { mode: "pinned", harnessId: "opencode" } });
  assert.deepEqual(preferred, { ...muse, harnessId: "opencode" });
  // Pi also lists OpenCode Zen under the same ids; that row is not the default.
  assert.equal(modelIdentityMatches({ ...muse, name: "Muse", harnessId: "pi" }, preferred!), false);
  assert.equal(modelIdentityMatches({ ...muse, name: "Muse" }, preferred!), true, "an untagged row is OpenCode's");
});
