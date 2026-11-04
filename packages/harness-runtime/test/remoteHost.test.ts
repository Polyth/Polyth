import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRemoteFileBytes, type RemoteProcessHost } from "../src/remoteHost.ts";

// The fake host runs the remote argv locally in the requested directory, the
// way the SSH transport's raw-pipe process command does on the far side.
const host: RemoteProcessHost = {
  label: "dev@remote",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  start: async () => { throw new Error("unused"); },
  forward: async () => { throw new Error("unused"); },
  processCommand: (argv, opts) => ({ command: "sh", args: ["-c", 'cd "$0" || exit 78; exec "$@"', opts?.cwd ?? "/", ...argv] }),
};

test("readRemoteFileBytes returns a host file's exact bytes and enforces its cap", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-remote-bytes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from([0x89, 0x50, 0x00, 0xff, 0x0d, 0x0a, 0x80, 0x1a]);
  writeFileSync(join(dir, "image.png"), bytes);

  assert.deepEqual(Buffer.from(await readRemoteFileBytes(host, "image.png", { cwd: dir, maxBytes: 64 })), bytes);
  assert.deepEqual(Buffer.from(await readRemoteFileBytes(host, join(dir, "image.png"), { maxBytes: 64 })), bytes);
  await assert.rejects(readRemoteFileBytes(host, "gone.png", { cwd: dir, maxBytes: 64 }), { code: "not-found" });
  await assert.rejects(readRemoteFileBytes(host, ".", { cwd: dir, maxBytes: 64 }), { code: "not-found" });
  await assert.rejects(readRemoteFileBytes(host, "image.png", { cwd: dir, maxBytes: 4 }), { code: "too-large" });
  await assert.rejects(readRemoteFileBytes(host, "image.png", { cwd: join(dir, "missing"), maxBytes: 64 }), { code: "runtime-unavailable" });
});
