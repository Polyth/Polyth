import test from "node:test";
import assert from "node:assert/strict";
import type {
  AgentCapabilityContribution,
  AgentCapabilityContributionRegistry,
} from "@polyth/contracts";
import type { BrowserService } from "../src/index.ts";
import registerBrowserPackage from "../src/serverEntry.ts";
import {
  SERVER_APPLICATION_SURFACE,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";

const APPLICATION_URL = "http://127.0.0.1:4400";

test("production Browser contribution follows the live exact login-origin seam only", async () => {
  const previousFakeBrowser = process.env.POLYTH_FAKE_BROWSER;
  process.env.POLYTH_FAKE_BROWSER = "1";
  const contributions = new Map<string, AgentCapabilityContribution>();
  let pkg: ServerPackage | undefined;
  let loginOrigin: string | null = APPLICATION_URL;
  const services = new Map<string, unknown>();
  const capabilities: AgentCapabilityContributionRegistry = {
    register(_owner, next) {
      contributions.set(next.descriptor.id, next);
      return { dispose: () => { contributions.delete(next.descriptor.id); } };
    },
    list: () => [...contributions.values()],
    resolve: () => [...contributions.values()].map((c) => c.descriptor),
    contribution: (id) => contributions.get(id),
    executor: (id) => contributions.get(id)?.execute,
  };
  const contribution = () => contributions.get("browser.polyth-browser");
  services.set(serverServiceKey("harness.capabilities").id, capabilities);
  services.set(SERVER_APPLICATION_SURFACE.id, {
    controlledBrowserLoginOrigin: () => loginOrigin,
  });
  const host = {
    events: {
      append: async (sessionId: string, type: string, data: object) => ({
        id: `${sessionId}:${type}`,
        sessionId,
        seq: 1,
        time: Date.now(),
        type,
        data,
        v: 1,
      }),
    },
    services: {
      provide: (key: { id: string }, value: unknown) => { services.set(key.id, value); },
      get: (key: { id: string }) => services.get(key.id),
      require: (key: { id: string }) => {
        if (!services.has(key.id)) throw new Error(`missing service ${key.id}`);
        return services.get(key.id);
      },
      ids: () => [...services.keys()],
    },
  } as unknown as ServerPackageHost;

  try {
    pkg = await registerBrowserPackage(host);
    await pkg.onEnable?.();
    const tool = contribution();
    assert.ok(tool, "browser tool must be registered");
    assert.equal(tool.descriptor.id, "browser.polyth-browser");
    assert.ok(tool.execute);
    assert.equal(typeof tool.autoApprove, "function");
    assert.equal(tool.descriptor.kind, "tool");
    if (tool.descriptor.kind !== "tool") throw new Error("Browser contribution must be a tool");
    assert.match(tool.descriptor.description, /Take control/);
    assert.match(tool.descriptor.description, /return control to the agent/);
    assert.match(tool.descriptor.description, /reply when it is ready/);
    assert.match(tool.descriptor.description, /Never request credentials/);
    // Deployment skill: available in every project, not a project-owned managed skill.
    const skill = contributions.get("browser.skill.polyth-browser");
    assert.ok(skill, "browser deployment skill must be registered");
    assert.equal(skill.descriptor.kind, "skill");
    assert.equal(skill.descriptor.scope, "deployment");
    assert.match(skill.descriptor.instructions, /polyth_browser/);

    const opened = JSON.parse((await tool.execute({
      action: "browser.open",
      parameters: { url: `${APPLICATION_URL}/` },
    }, {
      spaceId: "space-a",
      projectId: "project-a",
      sessionId: "session-a",
      cwd: process.cwd(),
    })).output) as { browserSessionId: string; url: string };
    assert.equal(opened.url, `${APPLICATION_URL}/`);

    const browser = services.get(serverServiceKey<BrowserService>("browser").id) as BrowserService;
    await assert.rejects(
      () => browser.navigate(opened.browserSessionId, "http://127.0.0.1:9999/", "agent"),
      (error: Error & { code?: string }) => error.code === "blocked-private",
    );
    await assert.rejects(
      () => browser.navigate(opened.browserSessionId, "http://169.254.169.254/latest/meta-data", "agent"),
      (error: Error & { code?: string }) => error.code === "blocked-private",
    );
    loginOrigin = null;
    await assert.rejects(
      () => browser.navigate(opened.browserSessionId, `${APPLICATION_URL}/after-auth-policy-change`, "agent"),
      (error: Error & { code?: string }) => error.code === "blocked-private",
    );
  } finally {
    await pkg?.onDisable?.();
    if (previousFakeBrowser === undefined) delete process.env.POLYTH_FAKE_BROWSER;
    else process.env.POLYTH_FAKE_BROWSER = previousFakeBrowser;
  }
});
