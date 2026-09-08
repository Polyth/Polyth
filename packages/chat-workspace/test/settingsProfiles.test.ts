import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ChatProfileDto, ChatWorkspaceSettingsDto } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  getComputedStyle: (elt: Element) =>
    (dom as unknown as { getComputedStyle(el: Element): CSSStyleDeclaration }).getComputedStyle(elt),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settings: ChatWorkspaceSettingsDto = {
  defaultProviderId: "chatgpt",
  restoreLastTabs: true,
  externalLinkBehavior: "prompt",
  defaultTarget: "current-session",
  warnTokenThreshold: 8000,
  liveTabLimit: 3,
  hibernateDelayMs: 300_000,
  streamQuality: 60,
};

const customProfile: ChatProfileDto = {
  id: "profile-custom-1",
  providerId: "custom",
  name: "Test chat",
  customUrl: "http://127.0.0.1:8765/",
  lastUsedAt: Date.now() - 120_000,
  createdAt: Date.now() - 3_600_000,
  approvedOrigins: [],
};

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const raw = String(input);
  const path = raw.includes("://") ? new URL(raw).pathname : raw;
  if (path.endsWith("/api/chat-workspace/settings")) {
    return new Response(JSON.stringify(settings), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (path.endsWith("/api/chat-workspace/profiles")) {
    return new Response(JSON.stringify({ profiles: [customProfile] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return originalFetch(raw.startsWith("/") ? `http://127.0.0.1:4400${raw}` : raw, init);
};

register("./tsxHooks.mjs", import.meta.url);

test("settings page lists custom profiles in Custom chats section", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ChatWorkspaceSettingsPage } = await import("../widgets/ChatWorkspaceSettingsPage.tsx");
  const { activateProject } = await import("../../../apps/web/src/store.ts");

  activateProject("project-1");

  const host = {
    navigation: { openWorkspacePane: () => {} },
  } as unknown as WebPackageHost;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ChatWorkspaceSettingsPage, { host }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  const text = container.textContent ?? "";
  assert.doesNotMatch(text, /Default chat/);
  assert.doesNotMatch(text, /Open external links/);
  assert.match(text, /Custom chats/);
  assert.match(text, /Test chat/);
  assert.match(text, /127\.0\.0\.1:8765/);
  assert.match(text, /Last used/);
  assert.ok([...container.querySelectorAll("button")].some((btn) => btn.textContent === "···"));

  await act(async () => { root.unmount(); });
  container.remove();
});
