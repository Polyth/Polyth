// The remote FileService generates POSIX shell commands; this fake host
// executes them in REAL bash so join/syntax errors (the `case ... in;`
// class of bug) fail here instead of on a user's server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteHost, RemoteProcessHandle } from "@polyth/contracts";
import { createRemoteFileService } from "../src/remote.ts";

const bashHost = (cwd: string): RemoteHost => {
  const run = (command: string, maxOutputBytes = 262_144) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn("bash", ["-c", `cd -- ${cwd} && ${command}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("exit", (code) => resolve({
        code: code ?? -1,
        stdout: stdout.slice(0, maxOutputBytes),
        stderr: stderr.slice(0, maxOutputBytes),
      }));
    });
  return {
    label: "test@localhost",
    exec: (command, opts) => run(command, opts?.maxOutputBytes),
    async start(command): Promise<RemoteProcessHandle> {
      const result = await run(command);
      const outputs = new Set<(chunk: string) => void>();
      const exits = new Set<(code: number | null) => void>();
      // Replay the full output, then exit — the service only reads.
      setTimeout(() => {
        if (result.stdout) for (const cb of outputs) cb(result.stdout);
        for (const cb of exits) cb(result.code);
      }, 0);
      return {
        onOutput(cb) {
          outputs.add(cb);
          return { dispose: () => { outputs.delete(cb); } };
        },
        onExit(cb) {
          exits.add(cb);
          return { dispose: () => { exits.delete(cb); } };
        },
        async kill() { for (const cb of exits) cb(null); },
      };
    },
    async forward() { throw new Error("not used"); },
  };
};

test("remote file service round-trips through a real remote shell", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-remote-fs-"));
  try {
    const host = bashHost(root);
    const fs = createRemoteFileService(host);

    // mkdir + tree
    await fs.mkdir(root, "src");
    await fs.mkdir(root, "src/nested");
    await fs.mkdir(root, "docs");
    const tree = await fs.tree(root, {});
    assert.deepEqual(tree.map((e) => `${e.dir ? "d:" : "f:"}${e.path}`), ["d:docs", "d:src"]);

    // write + read + stat + revision
    const { revision } = await fs.write(root, "src/hello.txt", "hello remote\n");
    assert.match(revision, /^[0-9a-z]+-[0-9a-z]+$/);
    const read = await fs.read(root, "src/hello.txt");
    assert.equal(read.content, "hello remote\n");
    assert.equal(read.truncated, false);
    assert.equal(read.revision, revision);
    const st = await fs.stat(root, "src/hello.txt");
    assert.equal(st.kind, "file");
    assert.equal(st.revision, revision);

    // revision conflict guard
    await assert.rejects(
      fs.write(root, "src/hello.txt", "clobber", { baseRevision: "wrong" }),
      (err: Error) => (err as { code?: string }).code === "conflict",
    );
    await fs.write(root, "src/hello.txt", "updated", { baseRevision: revision });
    assert.equal((await fs.read(root, "src/hello.txt")).content, "updated");

    // binary refusal for text writes + binary read flags tooLarge
    writeFileSync(join(root, "src/blob.bin"), Buffer.from([1, 2, 0, 3, 4]));
    await assert.rejects(
      fs.write(root, "src/blob.bin", "text over binary"),
      (err: Error) => (err as { code?: string }).code === "invalid-input",
    );
    const binary = await fs.read(root, "src/blob.bin");
    assert.equal(binary.tooLarge, true);

    // chunked bytes write (crosses the 60 KiB chunk boundary)
    const big = Buffer.alloc(150 * 1024, 0x61);
    await fs.writeBytes(root, "src/big.bin", big);
    const bigBack = await fs.readRaw(root, "src/big.bin");
    assert.equal(bigBack.data.length, big.length);
    assert.ok(bigBack.data.equals(big));

    // rename + remove
    await fs.rename(root, "src/hello.txt", "src/renamed.txt");
    await assert.rejects(fs.rename(root, "src/renamed.txt", "src/renamed.txt"), /already exists/i);
    await fs.remove(root, "src/renamed.txt");
    await assert.rejects(fs.read(root, "src/renamed.txt"), /cannot stat/);

    // searchScored: exact basename wins over fuzzy
    const hits = await fs.searchScored(root, "hello");
    assert.deepEqual(hits.map((h) => h.path), []);
    writeFileSync(join(root, "src/hello.txt"), "hi");
    const scored = await fs.searchScored(root, "hello");
    assert.equal(scored[0]!.path, "src/hello.txt");
    assert.equal(scored[0]!.kind, "file");
    assert.ok(scored[0]!.score > 0.8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});