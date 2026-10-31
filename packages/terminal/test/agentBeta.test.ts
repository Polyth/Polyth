import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalService } from "../src/index.ts";

test("agent beta TerminalService refuses interactive and bounded execution", async () => {
  const before = process.env.POLYTH_AGENT_BETA;
  process.env.POLYTH_AGENT_BETA = "1";
  try {
    const terminal = createTerminalService({ forcePipe: true });
    await assert.rejects(
      () => terminal.create({ projectId: "p", cwd: process.cwd() }),
      /read-only/,
    );
    await assert.rejects(
      () => terminal.run({ projectId: "p", cwd: process.cwd(), cmd: "echo blocked" }),
      /read-only/,
    );
    assert.equal(terminal.list().length, 0);
  } finally {
    if (before === undefined) delete process.env.POLYTH_AGENT_BETA;
    else process.env.POLYTH_AGENT_BETA = before;
  }
});
