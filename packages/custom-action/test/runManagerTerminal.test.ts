// End-to-end over the real terminal service: a background run spawns a real
// shell, stays out of Terminal tab lists, captures its output and reports the
// real exit code; Stop ends a long command.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceContext } from "@polyth/contracts";
import { createTerminalService } from "@polyth/terminal";
import { normalizeActionInput, type ActionRunDto, type CustomActionDto } from "../src/actionModel.ts";
import { createRunManager } from "../src/runManager.ts";
import { terminalPlainText } from "../src/terminalText.ts";

const space: SpaceContext = {
  spaceId: "s1", spaceSlug: "s1", userId: "u1", role: "owner", deployment: "local-trusted", storageDir: "/tmp/s1",
};

const action = (command: string, id = "a1"): CustomActionDto => ({
  id,
  ...normalizeActionInput({ name: "Real", command }),
  createdAt: 1,
  updatedAt: 1,
});

async function until(read: () => ActionRunDto | undefined, done: (run: ActionRunDto) => boolean, ms = 8_000): Promise<ActionRunDto> {
  const deadline = Date.now() + ms;
  for (;;) {
    const run = read();
    if (run && done(run)) return run;
    if (Date.now() > deadline) throw new Error(`run did not settle: ${JSON.stringify(run)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a real background run captures output and its exit code without a Terminal tab", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "custom-action-run-"));
  const terminals = createTerminalService({ forcePipe: true });
  const runs = createRunManager({ terminals: () => terminals, startChat: async () => "x" });
  t.after(async () => {
    await runs.dispose();
    await terminals.closeAll().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  });

  const { run } = await runs.start({ space, action: action("printf 'hello from %s\\n' \"$(basename \"$PWD\")\"; exit 3"), projectId: "p1", sessionId: null, cwd });
  assert.equal(terminals.list("p1").length, 0, "a background run never appears as a Terminal tab");
  const done = await until(() => runs.list(space).find((item) => item.id === run.id), (item) => item.status !== "running");
  assert.equal(done.status, "failed");
  assert.equal(done.exitCode, 3);
  const output = runs.output(space, run.id, 0);
  assert.match(terminalPlainText(output.text), /hello from custom-action-run-/);
  assert.equal(terminals.list().length, 0);
});

test("Stop ends a long-running real command", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "custom-action-run-"));
  const terminals = createTerminalService({ forcePipe: true });
  const runs = createRunManager({ terminals: () => terminals, startChat: async () => "x" });
  t.after(async () => {
    await runs.dispose();
    await terminals.closeAll().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  });
  const { run } = await runs.start({ space, action: action("echo started; sleep 30", "a2"), projectId: "p1", sessionId: null, cwd });
  await until(() => runs.list(space).find((item) => item.id === run.id), () => runs.output(space, run.id, 0).text.includes("started"));
  const stopped = await runs.stop(space, run.id);
  assert.equal(stopped.status, "stopped");
});
