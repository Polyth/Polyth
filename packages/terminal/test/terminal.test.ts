// Terminal service tests: real long-lived child (`cat`) for I/O roundtrip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createTerminalService } from "../src/index.ts";

let cwd: string;
const services: ReturnType<typeof createTerminalService>[] = [];
const newService = () => {
  const t = createTerminalService();
  services.push(t);
  return t;
};
test.before(async () => { cwd = await mkdtemp(join(tmpdir(), "polyth-term-")); });
test.after(async () => {
  // close every session so no child keeps the runner alive
  for (const t of services) for (const info of t.list()) await t.close(info.id).catch(() => {});
  await rm(cwd, { recursive: true, force: true });
});

test("create + write + read roundtrip through a long-lived child", async () => {
  const t = newService();
  const { id: termId } = await t.create({ projectId: "p", cwd, cmd: "cat" });
  assert.ok(termId, "terminalId returned");

  const echo = new Promise<string>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("no output from cat")), 5000);
    const sub = t.onData((id, data) => {
      if (id !== termId) return;
      if (data.includes("hello, polyth")) { clearTimeout(timer); sub.dispose(); res(data); }
    });
    t.write(termId, "hello, polyth\n");
  });
  assert.match(await echo, /hello, polyth/);

  const info = t.get(termId);
  assert.equal(info?.running, true);
  assert.equal(info?.cwd, cwd);
  assert.equal(info?.title, basename(cwd)); // basename of cwd

  await t.close(termId);
  assert.equal(t.get(termId), undefined, "closed terminal removed");
});

test("list filters by projectId", async () => {
  const t = newService();
  await t.create({ projectId: "proj-a", cwd, cmd: "cat" });
  await t.create({ projectId: "proj-b", cwd, cmd: "cat" });

  const a = t.list("proj-a");
  assert.equal(a.length, 1);
  assert.equal(a[0]!.projectId, "proj-a");
  assert.equal(t.list().length, 2);
});

test("exit is reported when the child exits by itself", async () => {
  const t = newService();
  const { id } = await t.create({ projectId: "p", cwd, cmd: "echo done" }); // exits immediately
  const exit = await new Promise<number | null>((res) => {
    const sub = t.onExit((eid, code) => { if (eid === id) { sub.dispose(); res(code); } });
    setTimeout(() => res("timeout" as unknown as number), 5000).unref();
  });
  assert.equal(exit, 0);
  assert.equal(t.get(id)?.running, false);
});

test("resize + write to a closed terminal are no-ops", async () => {
  const t = newService();
  const { id } = await t.create({ projectId: "p", cwd, cmd: "cat" });
  await t.close(id);
  assert.doesNotThrow(() => { t.resize(id, 120, 40); t.write(id, "x"); });
});

test("run captures bounded command output and removes the short-lived terminal", async () => {
  const t = newService();
  const result = await t.run(
    { projectId: "p", cwd, cmd: "printf 'prefix-'; printf '1234567890'" },
    { timeoutMs: 5_000, maxOutputBytes: 1_024 },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  assert.equal(result.output, "prefix-1234567890");
  assert.equal(t.list("p").length, 0);
});

test("run times out a long command", async () => {
  const t = newService();
  const result = await t.run(
    { projectId: "p", cwd, cmd: "sleep 5" },
    { timeoutMs: 100, maxOutputBytes: 1_024 },
  );
  assert.equal(result.timedOut, true);
  assert.equal(t.list("p").length, 0);
});
