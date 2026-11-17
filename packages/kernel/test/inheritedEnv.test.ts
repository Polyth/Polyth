import test from "node:test";
import assert from "node:assert/strict";
import { scrubInheritedEnv } from "../src/inheritedEnv.ts";

test("scrubInheritedEnv removes repository redirects, git config injection and shell startup hooks", () => {
  const input: NodeJS.ProcessEnv = {
    GIT_DIR: "/x", GIT_WORK_TREE: "/x", GIT_INDEX_FILE: "/x", GIT_OBJECT_DIRECTORY: "/x",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/x", GIT_COMMON_DIR: "/x", GIT_NAMESPACE: "x", GIT_PREFIX: "x",
    GIT_CONFIG_PARAMETERS: "'core.pager=evil'", GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: "evil", GIT_CONFIG_KEY_12: "a", GIT_CONFIG_VALUE_12: "b",
    BASH_ENV: "/x", ENV: "/x", SHELLOPTS: "xtrace", BASHOPTS: "x", PS4: "$(evil)",
    PATH: "/usr/bin", HOME: "/home/u", SSH_AUTH_SOCK: "/s", GIT_SSH_COMMAND: "ssh -i k", GIT_ASKPASS: "/a",
    GIT_CONFIG_GLOBAL: "/g", LANG: "C.UTF-8",
  };
  const snapshot = { ...input };
  const out = scrubInheritedEnv(input);
  assert.deepEqual(Object.keys(out).sort(), ["GIT_ASKPASS", "GIT_CONFIG_GLOBAL", "GIT_SSH_COMMAND", "HOME", "LANG", "PATH", "SSH_AUTH_SOCK"]);
  assert.deepEqual(input, snapshot, "the input is not mutated");
  assert.notEqual(out, input);
});

test("scrubInheritedEnv matches Windows-style mixed-case names", () => {
  assert.deepEqual(scrubInheritedEnv({ Git_Dir: "/x", Bash_Env: "/y", Path: "C:\\bin" }), { Path: "C:\\bin" });
});
