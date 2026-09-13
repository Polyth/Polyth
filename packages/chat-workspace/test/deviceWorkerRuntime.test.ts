import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakeProfileDriver,
  createProfileRegistry,
  resetFakeProfileLocks,
} from "@polyth/browser";
import { createChatWorkspaceDeviceWorkerRuntime } from "../src/deviceWorkerRuntime.ts";
import type { ChatWorkspaceDeviceEvent } from "../src/deviceRuntimeProtocol.ts";

test("executes local profile and tab lifecycle without exposing browser content", async () => {
  resetFakeProfileLocks();
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver() });
  const events: ChatWorkspaceDeviceEvent[] = [];
  const runtime = createChatWorkspaceDeviceWorkerRuntime({
    profiles,
    dataDir: mkdtempSync(join(tmpdir(), "polyth-chat-worker-")),
    emit: (event) => events.push(event),
  });

  const profile = await runtime.execute({
    kind: "profile.ensure",
    requestId: "p1",
    profileId: "profile-1",
    providerId: "claude",
    homeUrl: "https://claude.ai/new",
    allowedOrigins: ["https://claude.ai"],
    approvedOrigins: [],
  });
  assert.equal(profile.ok, true);

  const tab = await runtime.execute({
    kind: "tab.ensure",
    requestId: "t1",
    projectId: "project-1",
    tab: {
      id: "tab-1",
      profileId: "profile-1",
      url: "https://claude.ai/new",
      pinned: false,
    },
  });
  assert.equal(tab.ok, true);
  assert.equal(profiles.getTab("tab-1")?.profileId, "profile-1");
  assert.ok(events.some((event) => event.kind === "tab.state" && event.tabId === "tab-1"));

  const pin = await runtime.execute({
    kind: "tab.set-pinned",
    requestId: "pin-1",
    projectId: "project-1",
    tabId: "tab-1",
    pinned: true,
  });
  assert.equal(pin.ok, true);
  assert.equal(profiles.getTab("tab-1")?.pinned, true);

  const close = await runtime.execute({
    kind: "tab.close",
    requestId: "c1",
    projectId: "project-1",
    tabId: "tab-1",
  });
  assert.equal(close.ok, true);
  assert.equal(profiles.getTab("tab-1"), null);
  assert.ok(events.some((event) => event.kind === "tab.closed" && event.tabId === "tab-1"));

  await runtime.close();
});

test("rejects unsafe local profile ids before constructing a filesystem path", async () => {
  resetFakeProfileLocks();
  const profiles = createProfileRegistry({ driver: createFakeProfileDriver() });
  const runtime = createChatWorkspaceDeviceWorkerRuntime({
    profiles,
    dataDir: mkdtempSync(join(tmpdir(), "polyth-chat-worker-")),
    emit() {},
  });

  const result = await runtime.execute({
    kind: "profile.ensure",
    requestId: "bad",
    profileId: "../escape",
    providerId: "custom",
    homeUrl: "about:blank",
    allowedOrigins: [],
    approvedOrigins: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid-input");
  await runtime.close();
});
