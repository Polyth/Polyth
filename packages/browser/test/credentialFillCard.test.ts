// Mounted credential-fill approval card: reloads on this chat's vault-fill
// session facts instead of polling the Browser list several times a second.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { BrowserSessionDto } from "@polyth/contracts";
import type { BrowserVaultFillRequestDto } from "@polyth/session/web-api";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
  location: dom.location, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
  Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: clearTimeout,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const { default: CredentialFillApprovalCard } = await import("../widgets/CredentialFillApprovalCard.tsx");
const { publishBrowserSessionEvent } = await import("../widgets/browserSignals.ts");

const tab: BrowserSessionDto = { id: "b1", projectId: "p", sessionId: "s", status: "ready", url: "https://example.com/login", title: "Login",
  viewport: { width: 1280, height: 800, deviceScaleFactor: 1 }, colorScheme: "no-preference", revision: 1, engine: "fake" };
const request: BrowserVaultFillRequestDto = { id: "r1", browserSessionId: "b1", sessionId: "s", projectId: "p", handle: "github-login",
  label: "GitHub", origin: "https://example.com", selector: "input#password", submit: false, createdAt: 0, expiresAt: 60_000 };
const event = (type: string, sessionId: string) => ({ id: `${type}-${sessionId}`, sessionId, seq: 1, time: 0, type, data: {}, v: 1 as const });
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

test("the card appears and clears on vault-fill facts without polling", async () => {
  const original = { ...api };
  let lists = 0;
  let pending: BrowserVaultFillRequestDto[] = [];
  api.browserList = async () => { lists += 1; return [tab]; };
  api.browserVaultFillRequests = async () => [...pending];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(CredentialFillApprovalCard, { projectId: "p", sessionId: "s" })); });
    await wait(1_000);
    assert.equal(lists, 1, "one load on mount, none while idle (was every 750 ms)");
    assert.equal(container.querySelector("section"), null);

    pending = [request];
    await act(async () => { publishBrowserSessionEvent(event("browser/vault-fill-requested", "other")); });
    await wait(0);
    assert.equal(container.querySelector("section"), null, "another chat's request is not this card's");

    await act(async () => { publishBrowserSessionEvent(event("browser/vault-fill-requested", "s")); });
    await wait(0);
    assert.match(container.querySelector("h3")?.textContent ?? "", /Allow credential fill/);

    pending = [];
    await act(async () => { publishBrowserSessionEvent(event("browser/vault-fill-resolved", "s")); });
    await wait(0);
    assert.equal(container.querySelector("section"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Object.assign(api, original);
  }
});
