import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSessionDefaults,
  projectRemembersModelSelection,
  resolveProjectModelDefault,
  resolveSessionDefaultModel,
} from "../src/sessionDefaults.ts";

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
});
