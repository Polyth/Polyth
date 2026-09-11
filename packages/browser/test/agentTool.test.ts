import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, readdir } from "node:fs/promises";
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
  const viewer = browser.onFrame((event) => {
    if (browser.get(event.browserSessionId)) browser.setViewerVisible(event.browserSessionId, true);
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
    viewer.dispose();
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

test("agent works in background, keeps canonical sessions separate, and audits direct tools", async () => {
  const audit: Array<{ sessionId: string; type: string; data: unknown }> = [];
  const browser = createBrowserService({
    driver: createFakeDriver({ pages: { [HOME]: { title: "Home", text: "Welcome" }, [`${HOME}manual`]: { title: "Manual", text: "User-created state" } } }),
    allowedOrigins: () => ["http://127.0.0.1:5173"],
    append: async (sessionId, type, data) => { audit.push({ sessionId, type, data }); },
  });
  const execute = createBrowserAgentTool(browser).execute!;
  const ctx = { spaceId: "a", projectId: "p", sessionId: "canonical", cwd: process.cwd() };
  try {
    const foreign = await browser.create({ projectId: "p", sessionId: "other", url: HOME });
    await execute({ action: "browser.open", parameters: { url: HOME } }, ctx);
    const own = browser.list().find((b) => b.sessionId === ctx.sessionId)!;
    assert.ok(own);
    assert.notEqual(own.id, foreign.id);
    assert.equal(own.url, HOME, "authorized navigation runs without a visible Browser surface");
    assert.equal(browser.get(own.id)?.url, HOME);
    await execute({ action: "browser.type", parameters: { selector: "input", value: "typed-private-value" } }, ctx);
    assert.ok(audit.some((e) => e.sessionId === ctx.sessionId && e.type === "browser/action-requested"));
    assert.ok(audit.some((e) => e.sessionId === ctx.sessionId && e.type === "browser/action-completed"));
    assert.ok(!JSON.stringify(audit).includes("typed-private-value"));
    browser.pauseAgent(own.id, true);
    await assert.rejects(execute({ action: "browser.open", parameters: { url: HOME } }, ctx), /paused/);
    await browser.navigate(own.id, `${HOME}manual`, "user");
    browser.pauseAgent(own.id, false);
    const resumed = await execute({ action: "browser.snapshot" }, ctx);
    assert.match(resumed.output, /User-created state/);
    assert.equal(browser.list().length, 2, "viewing/resuming does not create a second own browser");
  } finally { await browser.closeAll(); }
});


test("browser captures cannot follow a project-controlled screenshot directory symlink", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "browser-capture-root-"));
  const outside = await mkdtemp(join(tmpdir(), "browser-capture-outside-"));
  const browser = createBrowserService({ driver: createFakeDriver({ pages: {} }) });
  const ctx = { spaceId: "a", projectId: "p", sessionId: "s", cwd };
  try {
    await browser.create({ projectId: "p", sessionId: "s" });
    await symlink(outside, join(cwd, ".polyth"), "dir");
    await assert.rejects(createBrowserAgentTool(browser).execute!({ action: "browser.capture" }, ctx), /inside the project/);
    assert.deepEqual(await readdir(outside), []);
  } finally { await browser.closeAll(); await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
