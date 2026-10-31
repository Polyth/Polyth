import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import type { RemoteProcessHost } from "@polyth/harness-runtime/remote-host";
import { CLAUDE_REMOTE_BINARY, titleSafeClaudeSdk } from "../src/serverEntry.ts";

const launches: Array<{ argv: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>> }> = [];
const remote: RemoteProcessHost = {
  label: "dev@remote",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  start: async () => { throw new Error("unused"); },
  forward: async () => { throw new Error("unused"); },
  processCommand(argv, opts) {
    launches.push({ argv, ...opts });
    return { command: "ssh", args: ["-T", "--", "dev@remote", "remote-line"] };
  },
};

test("a remote Claude query spawns the host's CLI over SSH without local credentials", () => {
  let options: Record<string, any> | undefined;
  const sdk = {
    query(params: { options?: Record<string, unknown> }) {
      options = params.options;
      return {};
    },
    getSessionInfo: async () => null,
  };
  const wrapped = titleSafeClaudeSdk(
    sdk as unknown as Parameters<typeof titleSafeClaudeSdk>[0],
    CLAUDE_REMOTE_BINARY,
    { ANTHROPIC_API_KEY: "local-secret" },
    { host: remote, cwd: "/srv/app" },
  );
  const spawned: unknown[] = [];
  wrapped.query({
    prompt: "hello",
    options: {
      spawnClaudeCodeProcess(target: unknown) {
        spawned.push(target);
        return {} as never;
      },
    },
  } as never);
  // A bare name is a native binary to the SDK; the host's PATH resolves it.
  assert.equal(options?.pathToClaudeCodeExecutable, "claude");
  options!.spawnClaudeCodeProcess({
    command: "claude",
    args: ["--output-format", "stream-json"],
    cwd: "/srv/app",
    env: {
      ANTHROPIC_API_KEY: "local-secret",
      CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_AGENT_SDK_VERSION: "0.3.263",
    },
    signal: new AbortController().signal,
  });
  assert.deepEqual(launches.at(-1), {
    argv: ["claude", "--output-format", "stream-json"],
    cwd: "/srv/app",
    env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDE_AGENT_SDK_VERSION: "0.3.263" },
  });
  // The owned spawn hook (process authority) receives the local ssh launch.
  const target = spawned[0] as { command: string; args: string[]; cwd: string };
  assert.equal(target.command, "ssh");
  assert.deepEqual(target.args, ["-T", "--", "dev@remote", "remote-line"]);
  assert.equal(target.cwd, homedir());
});

test("a remote Claude session id is never interpolated into the host command", async () => {
  const sdk = { query: () => ({}), getSessionInfo: async () => { throw new Error("must not read local transcripts"); } };
  const wrapped = titleSafeClaudeSdk(
    sdk as unknown as Parameters<typeof titleSafeClaudeSdk>[0],
    CLAUDE_REMOTE_BINARY,
    {},
    { host: remote, cwd: "/srv/app" },
  );
  launches.length = 0;
  assert.equal(await wrapped.getSessionInfo("../../etc; rm -rf /" as never), undefined);
  assert.equal(launches.length, 0);
});
