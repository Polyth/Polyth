import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWellKnownFlow, readBoundedJson, runPinnedArgv } from "../src/providerAuthWellKnown.ts";
import { MAX_WELLKNOWN_BYTES } from "@polyth/models/auth/well-known";
import type { OpenCodeAuthTarget } from "../src/providerAuthTarget.ts";

const BIZARRE = "zz!!not-a-token!!xyz-42";
const LOCAL_TARGET: OpenCodeAuthTarget = {
  spaceId: "default",
  authorityId: "local-host",
  generation: 1,
  executionLocality: "local-process",
};

test("runPinnedArgv keeps stdout and stderr separate and bounds both", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wk-spawn-"));
  const script = join(dir, "cmd.mjs");
  writeFileSync(script, `
    process.stdout.write(${JSON.stringify(BIZARRE)});
    process.stderr.write("warn-only");
  `);
  const result = await runPinnedArgv({ argv: [process.execPath, script] });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.toString("utf8"), BIZARRE);
  assert.equal(result.stderr.toString("utf8"), "warn-only");
  assert.equal(result.stdoutOverflow, false);
});

test("runPinnedArgv kills overflowed stdout and does not mix stderr into the token", async () => {
  const result = await runPinnedArgv({
    argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(20000)); process.stderr.write('e'.repeat(100));"],
    maxStdout: 64,
    maxStderr: 32,
  });
  assert.equal(result.stdoutOverflow, true);
  assert.ok(result.stdout.byteLength <= 64);
  assert.equal(result.stdout.toString("utf8").includes("e"), false);
});

test("runPinnedArgv times out and can be aborted", async () => {
  await assert.rejects(
    () => runPinnedArgv({
      argv: [process.execPath, "-e", "setTimeout(() => {}, 30_000)"],
      timeoutMs: 80,
    }),
    (error: Error & { code?: string }) => error.code === "AUTH_EXPIRED",
  );
  const controller = new AbortController();
  const pending = runPinnedArgv({
    argv: [process.execPath, "-e", "setTimeout(() => {}, 30_000)"],
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (error: Error & { code?: string }) => error.code === "AUTH_CANCELLED");
});

test("well-known preview re-checks redirects and rejects HTML", async () => {
  const hops: string[] = [];
  const flow = createWellKnownFlow({
    now: () => 1,
    resolve: async () => ["203.0.113.10"],
    fetchImpl: async (input) => {
      const url = String(input);
      hops.push(url);
      if (url.includes("/.well-known/opencode") && hops.length === 1) {
        return new Response(null, { status: 302, headers: { location: "https://org.example/moved" } });
      }
      return new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } });
    },
  });
  await assert.rejects(() => flow.preview("https://org.example", LOCAL_TARGET));
  assert.equal(hops.length, 2);
});

test("well-known preview rejects a redirect onto metadata", async () => {
  const flow = createWellKnownFlow({
    now: () => 1,
    resolve: async (hostname) => hostname.includes("org") ? ["203.0.113.10"] : ["169.254.169.254"],
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    }),
  });
  await assert.rejects(() => flow.preview("https://org.example", LOCAL_TARGET));
});

test("readBoundedJson aborts after the byte cap without draining the rest of the stream", async () => {
  const chunk = new Uint8Array(16 * 1024);
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls > 20) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });
  const response = new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(
    () => readBoundedJson(response),
    (error: Error & { code?: string }) => error.code === "AUTH_WELLKNOWN_UNSAFE",
  );
  assert.ok(pulls < 20, `must stop reading after the cap, pulled ${pulls}`);
  assert.ok(MAX_WELLKNOWN_BYTES > 0);
});

test("takePin refuses a different authority than the reviewed pin", async () => {
  const flow = createWellKnownFlow({
    now: () => 1,
    resolve: async () => ["203.0.113.10"],
    fetchImpl: async () => new Response(JSON.stringify({
      auth: { command: ["echo", "x"], env: "ORG_TOKEN" },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const preview = await flow.preview("https://org.example", LOCAL_TARGET);
  assert.throws(
    () => flow.takePin("https://org.example", preview.hash, { ...LOCAL_TARGET, generation: 9 }),
    (error: Error & { code?: string }) => error.code === "AUTH_WELLKNOWN_UNSAFE",
  );
});

test("the same well-known document can be reviewed independently by two Spaces", async () => {
  const flow = createWellKnownFlow({
    now: () => 1,
    resolve: async () => ["203.0.113.10"],
    fetchImpl: async () => new Response(JSON.stringify({
      auth: { command: ["echo", "x"], env: "ORG_TOKEN" },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const spaceA: OpenCodeAuthTarget = { ...LOCAL_TARGET, spaceId: "spc_a" };
  const spaceB: OpenCodeAuthTarget = { ...LOCAL_TARGET, spaceId: "spc_b" };
  const previewA = await flow.preview("https://org.example", spaceA);
  const previewB = await flow.preview("https://org.example", spaceB);
  assert.equal(previewA.hash, previewB.hash);
  assert.throws(
    () => flow.takePin("https://org.example", previewA.hash, { ...spaceA, generation: 9 }),
    (error: Error & { code?: string; details?: string }) =>
      error.code === "AUTH_WELLKNOWN_UNSAFE" && Boolean(error.details?.includes("auth target")),
  );
  const pinA = flow.takePin("https://org.example", previewA.hash, spaceA);
  assert.equal(pinA.spaceId, "spc_a");
  assert.throws(
    () => flow.takePin("https://org.example", previewA.hash, spaceA),
    (error: Error & { code?: string; details?: string }) =>
      error.code === "AUTH_WELLKNOWN_UNSAFE" && Boolean(error.details?.includes("not reviewed") || error.details?.includes("already used")),
  );
  const pinB = flow.takePin("https://org.example", previewB.hash, spaceB);
  assert.equal(pinB.spaceId, "spc_b");
});
