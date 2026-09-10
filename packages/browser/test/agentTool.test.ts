import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserAgentTool } from "../src/agentTool.ts";
import { createBrowserService, createFakeDriver } from "../src/index.ts";

const HOME = "http://127.0.0.1:5173/";

test("portable browser capability opens and reads the project-scoped controlled browser", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "polyth-browser-agent-tool-"));
  const browser = createBrowserService({
    driver: createFakeDriver({ pages: { [HOME]: { title: "Home", text: "Welcome" } } }),
    allowedOrigins: () => ["http://127.0.0.1:5173"],
  });
  const contribution = createBrowserAgentTool(browser);
  const execute = contribution.execute!;
  const context = {
    spaceId: "space-a",
    projectId: "project-a",
    sessionId: "session-a",
    cwd,
  };
  try {
    assert.equal(contribution.descriptor.kind, "tool");
    assert.equal(contribution.descriptor.kind === "tool" ? contribution.descriptor.name : "", "polyth_browser");
    const opened = JSON.parse((await execute({
      action: "browser.open",
      parameters: { url: HOME, viewport: "mobile" },
    }, context)).output) as { url: string; browserSessionId: string; viewport: { width: number } };
    assert.equal(opened.url, HOME);
    assert.equal(opened.viewport.width, 390);
    assert.equal(browser.get(opened.browserSessionId)?.sessionId, "session-a");

    const snapshot = JSON.parse((await execute({
      action: "browser.snapshot",
      parameters: {},
    }, context)).output) as { text: string };
    assert.match(snapshot.text, /Welcome/);

    await assert.rejects(
      () => execute({ action: "browser.open", parameters: { url: "file:///etc/passwd" } }, context),
      /http or https/,
    );
  } finally {
    await browser.closeAll();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("portable browser capability does not adopt another project's session", async () => {
  const browser = createBrowserService({
    driver: createFakeDriver({ pages: { [HOME]: { title: "Home", text: "Welcome" } } }),
    allowedOrigins: () => ["http://127.0.0.1:5173"],
  });
  const execute = createBrowserAgentTool(browser).execute!;
  try {
    const foreign = await browser.create({ projectId: "project-b", sessionId: "session-b", url: HOME });
    await assert.rejects(
      () => execute({ action: "browser.snapshot", parameters: {} }, {
        spaceId: "space-a",
        projectId: "project-a",
        sessionId: "session-a",
        cwd: process.cwd(),
      }),
      /browser\.open first/,
    );
    assert.equal(browser.get(foreign.id)?.status, "ready");
  } finally {
    await browser.closeAll();
  }
});
