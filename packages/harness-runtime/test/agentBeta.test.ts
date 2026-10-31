import test from "node:test";
import assert from "node:assert/strict";
import {
  agentBetaEnabled,
  isFilesystemMutationPermission,
} from "../src/agentBeta.ts";

test("agent beta env is explicit", () => {
  assert.equal(agentBetaEnabled({ POLYTH_AGENT_BETA: "1" }), true);
  assert.equal(agentBetaEnabled({ POLYTH_AGENT_BETA: "true" }), false);
  assert.equal(agentBetaEnabled({}), false);
});

test("agent beta mutation classifier blocks write and shell surfaces only", () => {
  for (const permission of [
    "edit",
    "write",
    "write_file",
    "edit_file",
    "execute_command",
    "rename_path",
    "move_file",
    "remove_file",
    "apply_patch",
    "bash",
    "powershell",
    "shell",
    "run_command",
    "notebook_edit",
    "fs/write",
    "delete",
    "move",
  ]) {
    assert.equal(isFilesystemMutationPermission(permission), true, permission);
  }

  for (const permission of [
    "read",
    "glob",
    "grep",
    "list",
    "webfetch",
    "websearch",
    "browser",
    "package-tool",
    "question",
  ]) {
    assert.equal(isFilesystemMutationPermission(permission), false, permission);
  }
});
