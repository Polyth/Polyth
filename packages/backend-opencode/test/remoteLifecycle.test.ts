import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  RemoteForwardHandle,
  RemoteHost,
  RemoteProcessHandle,
} from "@polyth/contracts";
import { createRemoteOpenCodeRuntime } from "../src/remote.ts";

const execSuccess = async (command: string) => {
  if (command.includes("command -v")) {
    return { code: 0, stdout: "1.18.18\n", stderr: "" };
  }
  if (command.includes(" db path")) {
    const expected = command.match(/OPENCODE_DB='([^']+)'/)?.[1] ?? "";
    return { code: 0, stdout: `${expected}\n`, stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
};

const listeningHandle = (
  port: number,
  onKill: () => Promise<void> = async () => {},
): RemoteProcessHandle => {
  const output = new Set<(chunk: string) => void>();
  const exit = new Set<(code: number | null) => void>();
  setImmediate(() => {
    for (const callback of output) {
      callback("POLYTH_REMOTE_PID=4321\n");
      callback(`opencode server listening on http://127.0.0.1:${port}\n`);
    }
  });
  return {
    onOutput(callback) {
      output.add(callback);
      return { dispose: () => { output.delete(callback); } };
    },
    onExit(callback) {
      exit.add(callback);
      return { dispose: () => { exit.delete(callback); } };
    },
    kill: onKill,
  };
};

test("remote process startup has a finite orchestration deadline", async () => {
  const host: RemoteHost = {
    label: "deadline.example",
    exec: execSuccess,
    async start() {
      return await new Promise<RemoteProcessHandle>(() => {});
    },
    async forward() {
      assert.fail("forward must not start after a startup deadline");
    },
  };
  const startedAt = Date.now();
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host,
      remotePath: "/srv/project",
      runtimeDir: "/var/lib/polyth/runtimes/project",
      lifecycleTimeoutMs: 25,
      listenTimeoutMs: 1_000,
    }),
    /process start exceeded 25ms/,
  );
  assert.ok(Date.now() - startedAt < 500);
});

test("timed-out remote forward is disposed if it resolves late", async () => {
  let processKills = 0;
  let lateForwardDisposals = 0;
  const host: RemoteHost = {
    label: "forward-deadline.example",
    exec: execSuccess,
    async start(command) {
      const port = Number(command.match(/--port (\d+)/)?.[1]);
      return listeningHandle(port, async () => {
        processKills += 1;
      });
    },
    async forward() {
      return await new Promise<RemoteForwardHandle>((resolveForward) => {
        setTimeout(() => {
          resolveForward({
            localPort: 49999,
            async dispose() {
              lateForwardDisposals += 1;
            },
          });
        }, 60);
      });
    },
  };
  await assert.rejects(
    () => createRemoteOpenCodeRuntime({
      host,
      remotePath: "/srv/project",
      runtimeDir: "/var/lib/polyth/runtimes/project",
      lifecycleTimeoutMs: 20,
      listenTimeoutMs: 1_000,
      pickPort: () => 48001,
    }),
    /forward exceeded 20ms/,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(processKills, 1);
  assert.equal(lateForwardDisposals, 1);
});
