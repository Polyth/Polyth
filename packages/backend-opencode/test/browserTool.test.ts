import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createBrowserService, createFakeDriver } from "@polyth/browser";
import {
  createBrowserToolBridge,
  createBrowserToolPluginSource,
  prepareBrowserToolEnvironment,
  resolveBrowserToolAction,
} from "../src/browserTool.ts";

const HOME = "http://127.0.0.1:5173/";

test("browser tool maps polyth-like actions onto the shared BrowserService", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "polyth-browser-tool-"));
  const browser = createBrowserService({
    driver: createFakeDriver({
      pages: {
        [HOME]: {
          title: "Home",
          text: "Welcome",
          links: { "text:Next": `${HOME}next` },
        },
        [`${HOME}next`]: { title: "Next", text: "Second page" },
      },
    }),
    allowedOrigins: () => ["http://127.0.0.1:5173"],
  });
  const bridge = createBrowserToolBridge({
    browser,
    canonicalSessionId: (backend) => backend === "backend-1" ? "session-1" : undefined,
    now: () => new Date("2026-08-22T05:00:00.000Z"),
  });
  const registration = bridge.register({ projectId: "project-1", cwd });
  const call = (action: string, parameters: Record<string, unknown> = {}) =>
    bridge.execute(registration.token, {
      action,
      parameters,
      context: { sessionID: "backend-1", directory: cwd },
    });

  try {
    const opened = await call("browser.open", { url: HOME, viewport: "mobile", colorScheme: "dark" });
    assert.equal(opened.url, HOME);
    assert.deepEqual(opened.viewport, { width: 390, height: 844 });
    assert.equal(opened.colorScheme, "dark");
    assert.equal(browser.list()[0]?.sessionId, "session-1");

    const snapshot = await call("browser.snapshot");
    assert.match(String(snapshot.text), /Welcome/);
    const subagentSnapshot = await bridge.execute(registration.token, {
      action: "browser.snapshot",
      parameters: {},
      context: { sessionID: "backend-subagent-1", directory: cwd },
    });
    assert.equal(subagentSnapshot.browserSessionId, opened.browserSessionId);
    assert.match(String(subagentSnapshot.text), /Welcome/);

    const clicked = await call("browser.click", { text: "Next" });
    assert.equal(clicked.url, `${HOME}next`);

    const inspected = await call("browser.inspect", { selector: "main" });
    assert.equal((inspected.result as { selector?: string }).selector, "main");

    const resized = await call("browser.resize", { viewport: "desktop" });
    assert.deepEqual(resized.viewport, { width: 1440, height: 900 });
    const recolored = await call("browser.colorScheme", { colorScheme: "light" });
    assert.equal(recolored.colorScheme, "light");

    const backed = await call("browser.back");
    assert.equal(backed.url, HOME);
    const forwarded = await call("browser.forward");
    assert.equal(forwarded.url, `${HOME}next`);
    await call("browser.scroll", { direction: "down" });
    await call("browser.scroll", { selector: "main" });
    await call("browser.back");
    await call("browser.type", { selector: "input#query", value: "hello", submit: true });
    assert.match(String((await call("browser.snapshot")).text), /input#query=hello/);

    const capture = await call("browser.capture", { label: "../../After fix" });
    assert.equal(capture.path, ".polyth/screenshots/after-fix-2026-08-22T05-00-00-000.webp");
    assert.match(String(capture.hint), /!\[\]\(\.polyth\/screenshots\/after-fix/);
    await access(join(cwd, String(capture.path)));

    const openedByBareName = await call("open", { url: HOME });
    assert.equal(openedByBareName.url, HOME);
    const snapByBareName = await call("snapshot");
    assert.match(String(snapByBareName.text), /Welcome/);

    await assert.rejects(
      () => call("browser.click"),
      /requires selector or text/,
    );
    const browserSessionId = String(opened.browserSessionId);
    browser.pauseAgent(browserSessionId, true);
    await assert.rejects(
      () => call("browser.snapshot"),
      (error: Error & { code?: string }) => error.code === "agent-paused",
    );
    browser.pauseAgent(browserSessionId, false);
  } finally {
    registration.dispose();
    await browser.closeAll();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("managed browser tool plugin merges with existing OpenCode plugins without persisting its token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-browser-plugin-"));
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.POLYTH_BROWSER_TOOL_URL;
  const originalToken = process.env.POLYTH_BROWSER_TOOL_TOKEN;
  try {
    const source = createBrowserToolPluginSource();
    assert.match(source, /polyth_browser/);
    assert.match(source, /browser\.snapshot/);
    assert.doesNotMatch(source, /token-for-test/);

    const env = await prepareBrowserToolEnvironment({
      endpoint: "http://127.0.0.1:4400/internal/opencode/browser-tool",
      token: "token-for-test",
      pluginDirectory: dir,
    }, {
      OPENCODE_CONFIG_CONTENT: `{"plugin":["file:///existing.js"],}`,
    });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as { plugin?: string[] };
    assert.equal(config.plugin?.[0], "file:///existing.js");
    assert.match(config.plugin?.[1] ?? "", /^file:.*polyth-browser-plugin\.js$/);
    assert.equal(env.POLYTH_BROWSER_TOOL_TOKEN, "token-for-test");

    const written = await readFile(join(dir, "polyth-browser-plugin.js"), "utf8");
    assert.equal(written, source);
    assert.doesNotMatch(written, /token-for-test/);

    const captured: { request?: { url: string; init?: RequestInit } } = {};
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      captured.request = { url: String(input), init };
      return new Response(JSON.stringify({
        schemaVersion: 1,
        ok: true,
        action: "browser.open",
        data: { url: HOME },
      }));
    }) as typeof fetch;
    process.env.POLYTH_BROWSER_TOOL_URL = env.POLYTH_BROWSER_TOOL_URL;
    process.env.POLYTH_BROWSER_TOOL_TOKEN = env.POLYTH_BROWSER_TOOL_TOKEN;

    const module = await import(`${pathToFileURL(join(dir, "polyth-browser-plugin.js")).href}?test=${Date.now()}`) as {
      PolythBrowserPlugin(): Promise<{
        tool: {
          polyth_browser: {
            execute(
              input: Record<string, unknown>,
              context: { sessionID: string; directory: string; abort: AbortSignal },
            ): Promise<string | { title: string; output: string }>;
          };
        };
      }>;
    };
    const plugin = await module.PolythBrowserPlugin();
    const output = await plugin.tool.polyth_browser.execute({
      action: "browser.open",
      url: HOME,
      parameters: { viewport: "mobile" },
    }, {
      sessionID: "backend-1",
      directory: dir,
      abort: new AbortController().signal,
    });
    const payload = typeof output === "string" ? JSON.parse(output) : JSON.parse(output.output);
    assert.equal(payload.ok, true);
    assert.equal(typeof output === "string" ? undefined : output.title, "Open a page in the browser panel");
    const request = captured.request;
    assert.ok(request);
    assert.equal(request?.url, env.POLYTH_BROWSER_TOOL_URL);
    assert.equal(request?.init?.headers && (request.init.headers as Record<string, string>).authorization, "Bearer token-for-test");
    const forwarded = JSON.parse(String(request?.init?.body)) as {
      action?: string;
      parameters?: Record<string, unknown>;
      context?: Record<string, unknown>;
    };
    assert.equal(forwarded.action, "browser.open");
    assert.deepEqual(forwarded.parameters, { url: HOME, viewport: "mobile" });
    assert.deepEqual(forwarded.context, { sessionID: "backend-1", directory: dir });
    assert.equal((forwarded as { tool?: string }).tool, "polyth_browser");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEndpoint === undefined) delete process.env.POLYTH_BROWSER_TOOL_URL;
    else process.env.POLYTH_BROWSER_TOOL_URL = originalEndpoint;
    if (originalToken === undefined) delete process.env.POLYTH_BROWSER_TOOL_TOKEN;
    else process.env.POLYTH_BROWSER_TOOL_TOKEN = originalToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test("bare action names resolve inside the browser tool", () => {
  assert.equal((resolveBrowserToolAction("open") as { action: string }).action, "browser.open");
  assert.equal((resolveBrowserToolAction("snapshot") as { action: string }).action, "browser.snapshot");
  assert.equal((resolveBrowserToolAction("browser.click") as { action: string }).action, "browser.click");
  assert.match((resolveBrowserToolAction("read") as { error: string }).error, /Use one of:/);
  assert.match((resolveBrowserToolAction("") as { error: string }).error, /missing/);
});

test("plugin schema tells the model how to drive the page", () => {
  const source = createBrowserToolPluginSource();
  assert.match(source, /only way to drive a page/);
  assert.match(source, /"const":"browser\.open"/);
  assert.match(source, /context\.metadata/);
  assert.match(source, /tool: "polyth_browser"/);
});

test("missing Chromium is an immediate agent-facing failure, not a timeout", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "polyth-browser-tool-"));
  const browser = createBrowserService({ driver: null, unavailableReason: "browser engine unavailable: nope" });
  const bridge = createBrowserToolBridge({ browser });
  const registration = bridge.register({ projectId: "project-1", cwd });
  try {
    await assert.rejects(
      () => bridge.execute(registration.token, {
        action: "open",
        parameters: { url: HOME },
      }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "unavailable");
        assert.match(error.message, /no Chromium executable was found/);
        assert.match(error.message, /POLYTH_CHROMIUM_PATH/);
        return true;
      },
    );
  } finally {
    registration.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
