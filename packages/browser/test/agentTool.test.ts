import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceStorage } from "@polyth/tenancy";
import { createBrowserAgentTool, createBrowserVaultFillAgentTool } from "../src/agentTool.ts";
import { writeBrowserAgentAutoApprove } from "../src/agentToolSettings.ts";
import { createBrowserService, createFakeDriver } from "../src/index.ts";
import { createBrowserVaultFillBroker } from "../src/vaultFill.ts";
import type { SecureSafeService } from "@polyth/contracts";

const HOME = "http://127.0.0.1:5173/";

test("agents can open and target multiple own tabs without controlling another session's tab", async () => {
  const browser = createBrowserService({
    driver: createFakeDriver({ pages: { [HOME]: { title: "Home", text: "First" }, [`${HOME}two`]: { title: "Two", text: "Second" } } }),
    allowedOrigins: () => ["http://127.0.0.1:5173"],
  });
  const execute = createBrowserAgentTool(browser).execute!;
  const context = { projectId: "p", sessionId: "one", cwd: process.cwd() };
  try {
    const first = JSON.parse((await execute({ action: "browser.open", parameters: { url: HOME } }, context)).output);
    const second = JSON.parse((await execute({ action: "browser.open", parameters: { url: `${HOME}two`, newTab: true } }, context)).output);
    assert.notEqual(first.browserSessionId, second.browserSessionId);
    assert.match((await execute({ action: "browser.snapshot", parameters: { browserSessionId: second.browserSessionId } }, context)).output, /Second/);
    assert.match((await execute({ action: "browser.snapshot" }, context)).output, /First/);
    const foreign = await browser.create({ projectId: "p", sessionId: "two", url: HOME });
    await assert.rejects(execute({ action: "browser.open", parameters: { url: `${HOME}two`, browserSessionId: foreign.id } }, context), /not found/);
    assert.equal(browser.get(foreign.id)?.url, HOME);
    await assert.rejects(execute({ action: "browser.open", parameters: { url: HOME, browserSessionId: second.browserSessionId, newTab: true } }, context), /newTab requires/);
  } finally { await browser.closeAll(); }
});

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


test("vault fill capability never exposes plaintext and binds approval to the live origin", async () => {
  const FORM = `${HOME}form`;
  const OTHER = "http://127.0.0.1:5174/";
  const audit: Array<{ type: string; data: unknown }> = [];
  const browser = createBrowserService({
    driver: createFakeDriver({
      pages: {
        [FORM]: { title: "Login", text: "Password" },
        [OTHER]: { title: "Other", text: "Different origin" },
      },
    }),
    allowedOrigins: () => ["http://127.0.0.1:5173", "http://127.0.0.1:5174"],
    append: async (_sessionId, type, data) => { audit.push({ type, data }); },
  });
  const broker = createBrowserVaultFillBroker();
  const entry = {
    id: "credential-1",
    handle: "UI_PASSWORD",
    label: "Polyth UI password",
    purpose: "Sign in",
    kind: "password" as const,
    scope: "project" as const,
    projectId: "project-a",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const vault = {
    list: () => [entry],
    useCredential: async (_request: unknown, use: (value: string) => unknown) => use("abc"),
  } as unknown as SecureSafeService;
  const append = async (_sessionId: string, type: string, data: unknown) => {
    audit.push({ type, data });
  };
  let resolvedSpaceId = "";
  const contribution = createBrowserVaultFillAgentTool(
    browser,
    (spaceId) => {
      resolvedSpaceId = spaceId;
      return vault;
    },
    broker,
    append as Parameters<typeof createBrowserVaultFillAgentTool>[3],
  );
  const execute = contribution.execute!;
  const ctx = {
    spaceId: "space-a",
    projectId: "project-a",
    sessionId: "session-a",
    cwd: process.cwd(),
  };

  try {
    const session = await browser.create({
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      url: FORM,
      actor: "agent",
    });

    const fill = execute({ selector: "input#pw", handle: "UI_PASSWORD" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = broker.list(session.id)[0]!;
    assert.ok(request);
    assert.equal(request.origin, "http://127.0.0.1:5173");
    assert.equal(request.handle, "UI_PASSWORD");
    assert.doesNotMatch(JSON.stringify(request), /abc/);
    assert.equal(broker.resolve(request.id, "allow"), true);

    const result = await fill;
    assert.equal(resolvedSpaceId, "space-a");
    assert.doesNotMatch(result.output, /abc/);
    const observed = await browser.observe(session.id);
    assert.doesNotMatch(observed.text, /abc/);
    assert.match(observed.text, /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(audit), /abc/);

    const blockedCapture = await createBrowserAgentTool(browser).execute!({ action: "browser.capture" }, ctx);
    const blockedCaptureOutput = JSON.parse(blockedCapture.output) as Record<string, unknown>;
    assert.equal(blockedCaptureOutput.screenshotAvailable, false);
    assert.equal(blockedCaptureOutput.reason, "sensitive-content");
    assert.match(String(blockedCaptureOutput.message), /Credential Vault fill/);

    const originBoundFill = execute({ selector: "input#pw", handle: "UI_PASSWORD" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const originRequest = broker.list(session.id)[0]!;
    assert.ok(originRequest);
    await browser.navigate(session.id, OTHER, "user");
    broker.resolve(originRequest.id, "allow");
    await assert.rejects(
      originBoundFill,
      (cause: Error & { code?: string }) => cause.code === "credential-origin-changed",
    );
    assert.doesNotMatch((await browser.observe(session.id)).text, /abc/);
    assert.equal(await contribution.autoApprove?.({
      spaceId: ctx.spaceId,
      projectId: ctx.projectId,
      cwd: ctx.cwd,
    }), true);
  } finally {
    broker.cancelAll();
    await browser.closeAll();
  }
});

test("vault fill finds the acting person's own handle and never another person's", async () => {
  const FORM = `${HOME}form`;
  const browser = createBrowserService({
    driver: createFakeDriver({ pages: { [FORM]: { title: "Login", text: "Password" } } }),
    allowedOrigins: () => ["http://127.0.0.1:5173"],
  });
  const broker = createBrowserVaultFillBroker();
  const personal = {
    id: "credential-p", handle: "MY_PASSWORD", label: "Alice's password", purpose: "Sign in",
    kind: "password" as const, scope: "global" as const, revision: 1, createdAt: 1, updatedAt: 1,
  };
  const resolvedFor: Array<string | undefined> = [];
  const vault = {
    list: () => [],
    listFor: (actorUserId: string | undefined) => (actorUserId === "alice" ? [{ ...personal, partition: "personal" }] : []),
    useCredential: async (request: { actorUserId?: string }, use: (value: string) => unknown) => {
      resolvedFor.push(request.actorUserId);
      return use("abc");
    },
  } as unknown as SecureSafeService;
  const execute = createBrowserVaultFillAgentTool(
    browser,
    () => vault,
    broker,
    (async () => {}) as Parameters<typeof createBrowserVaultFillAgentTool>[3],
  ).execute!;
  const base = { spaceId: "space-a", projectId: "project-a", sessionId: "session-a", cwd: process.cwd() };
  try {
    const session = await browser.create({ projectId: base.projectId, sessionId: base.sessionId, url: FORM, actor: "agent", ownerUserId: "alice" });
    // Bob's own tab in the same chat: his turn reaches the vault, which has no such handle for him.
    await browser.create({ projectId: base.projectId, sessionId: base.sessionId, url: FORM, actor: "agent", ownerUserId: "bob" });
    await assert.rejects(
      execute({ selector: "input#pw", handle: "MY_PASSWORD" }, { ...base, actorUserId: "bob" }),
      (cause: Error & { code?: string }) => cause.code === "not-found",
    );
    const fill = execute({ selector: "input#pw", handle: "MY_PASSWORD" }, { ...base, actorUserId: "alice" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = broker.list(session.id)[0];
    assert.ok(request);
    assert.equal(request.label, "Alice's password");
    broker.resolve(request.id, "allow");
    await fill;
    assert.deepEqual(resolvedFor, ["alice"]);
  } finally {
    broker.cancelAll();
    await browser.closeAll();
  }
});

test("browser contribution auto-approve follows the Space setting", async () => {
  const storage = createSpaceStorage(await mkdtemp(join(tmpdir(), "browser-auto-approve-contrib-")));
  const contribution = createBrowserAgentTool(createBrowserService({
    driver: createFakeDriver({ pages: { [HOME]: { title: "Home", text: "Welcome" } } }),
    allowedOrigins: () => ["http://127.0.0.1:5173"],
  }));
  const grant = {
    spaceId: "space-a",
    projectId: "project-a",
    cwd: process.cwd(),
    storage,
  };
  assert.equal(await contribution.autoApprove?.(grant), true);
  await writeBrowserAgentAutoApprove(storage, false);
  assert.equal(await contribution.autoApprove?.(grant), false);
  assert.equal(await contribution.autoApprove?.({ ...grant, storage: undefined }), false);
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
