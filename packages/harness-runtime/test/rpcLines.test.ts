import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStdioRpc, RPC_MAX_LINE_BYTES } from "../src/rpc.ts";

// A small stand-in for a harness: each request names what it should print.
const SERVER = `
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
  if (method === "echo") reply({ echoed: params.value });
  if (method === "big") reply({ text: "x".repeat(params.bytes) });
  if (method === "banner") { process.stdout.write("Active code page: 65001\\n"); reply({ ok: true }); }
  if (method === "noise") { for (let i = 0; i < params.lines; i += 1) process.stdout.write("not json\\n"); reply({ ok: true }); }
  if (method === "bigNotice") { process.stdout.write(JSON.stringify({ method: "note", params: { id: 7, text: "x".repeat(params.bytes) } }) + "\\n"); reply({ ok: true }); }
});
`;

const started = async (t: { after(fn: () => unknown): void }) => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-rpc-lines-"));
  const script = join(dir, "server.cjs");
  await writeFile(script, SERVER);
  const rpc = await createStdioRpc({ command: process.execPath, args: [script], cwd: dir, stateFile: join(dir, "state.json") });
  t.after(async () => {
    await rpc.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });
  let closed = false;
  rpc.onClose(() => { closed = true; });
  return { rpc, isClosed: () => closed };
};

test("a response split across many chunks arrives whole", async (t) => {
  const { rpc } = await started(t);
  const big = await rpc.request<{ text: string }>("big", { bytes: 3_000_000 }, 30_000);
  assert.equal(big.text.length, 3_000_000);
});

test("one response past the limit fails its own request and the runtime keeps answering", async (t) => {
  const { rpc, isClosed } = await started(t);
  await assert.rejects(rpc.request("big", { bytes: RPC_MAX_LINE_BYTES + 1024 }, 60_000), (error: { code?: string; responseTooLarge?: boolean }) => {
    assert.equal(error.code, "outcome-unknown");
    assert.equal(error.responseTooLarge, true);
    return true;
  });
  assert.equal(isClosed(), false);
  assert.deepEqual(await rpc.request("echo", { value: 1 }, 10_000), { echoed: 1 });
});

test("an oversized notification is skipped without failing a request it merely mentions", async (t) => {
  const { rpc, isClosed } = await started(t);
  const notes: string[] = [];
  rpc.onNotification((method) => notes.push(method));
  const slow = rpc.request("echo", { value: "kept" }, 60_000);
  assert.deepEqual(await rpc.request("bigNotice", { bytes: RPC_MAX_LINE_BYTES + 1024 }, 60_000), { ok: true });
  assert.deepEqual(await slow, { echoed: "kept" });
  assert.deepEqual(notes, []);
  assert.equal(isClosed(), false);
});

test("a stray line on stdout does not end the runtime, a stream of them does", async (t) => {
  const { rpc, isClosed } = await started(t);
  assert.deepEqual(await rpc.request("banner", {}, 10_000), { ok: true });
  assert.equal(isClosed(), false);
  await rpc.request("noise", { lines: 10 }, 10_000);
  assert.equal(isClosed(), false, "the count starts over after a valid line");
  await assert.rejects(rpc.request("noise", { lines: 200 }, 10_000));
  assert.equal(isClosed(), true);
});
