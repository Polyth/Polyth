import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { setPolythLinkNative, type ConnectionMetadata } from "../src/polythLink.ts";

const dom = new Window({ url: "http://localhost/", width: 430, height: 932 });
Object.assign(globalThis, {
  window: dom, document: dom.document, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
  HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Element: dom.Element, Node: dom.Node,
  location: dom.location, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("../../web/test/tsxHooks.mjs", import.meta.url);

const custom = new Map<string, string>();
const renamed: Array<[string, string]> = [];
const saved = (id: string, serverLabel: string): ConnectionMetadata => ({
  id,
  hostEndpointId: id,
  hostLabel: custom.get(id) || serverLabel,
  serverLabel,
  customLabel: custom.get(id) ?? "",
  pairingState: "active",
  lastUsedAt: 1,
  hasSecureIdentity: true,
});
setPolythLinkNative({
  parsePairingTicket: async () => ({ hostLabel: "", hostFingerprint: "", expiresAt: "" }),
  beginPairing: async () => ({ attemptId: "x", state: "prepared" }),
  beginNumericPairing: async () => ({ attemptId: "x", state: "prepared" }),
  confirmPairing: async () => ({ origin: "", bootstrapUrl: "", connectionId: "" }),
  cancelPairing: async () => undefined,
  listConnections: async () => [saved("a".repeat(64), "studio"), saved("b".repeat(64), "mac-mini")],
  connect: async () => new Promise(() => undefined),
  recoverConnection: async () => new Promise(() => undefined),
  disconnect: async () => undefined,
  forgetConnection: async () => undefined,
  renameConnection: async (connectionId, label) => {
    renamed.push([connectionId, label]);
    if (label.trim()) custom.set(connectionId, label.trim());
    else custom.delete(connectionId);
  },
  getStatus: async () => ({ state: "disconnected" }),
});

test("a saved server is renamed on this phone from its menu, and can go back to the computer's name", async () => {
  const { act } = await import("react");
  const { renderMobileConnection } = await import("../src/ConnectionScreen.tsx");
  const root = dom.document.createElement("div");
  root.id = "root";
  dom.document.body.append(root);
  const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const names = () => [...root.querySelectorAll(".mobile-connect-server-copy strong")].map((node) => node.textContent);
  const button = (text: string, within: { querySelectorAll(selector: string): ArrayLike<unknown> } = root) =>
    [...Array.from(within.querySelectorAll("button")) as HTMLButtonElement[]].find((node) => node.textContent?.trim() === text);
  /** Opens the row's ••• menu and picks Rename from it. */
  const rename = async (row: number) => {
    const menu = root.querySelectorAll("details.mobile-connect-server-menu")[row]!;
    menu.setAttribute("open", "");
    await act(async () => { button("Rename", menu)!.click(); });
    return menu;
  };

  await act(async () => { renderMobileConnection({ kind: "connect", recent: [], selectServer: true } as never, { veil: null }); });
  await flush();
  assert.deepEqual(names(), ["studio", "mac-mini"], "each server shows the name its computer gave it");

  const menu = await rename(1);
  assert.equal(menu.hasAttribute("open"), false, "the menu closes");
  const field = root.querySelector("form.mobile-connect-rename input[name='server-name']") as unknown as HTMLInputElement;
  assert.equal(field.value, "mac-mini");
  assert.equal(field.placeholder, "mac-mini");
  assert.equal(button("Use computer’s name"), undefined, "nothing to go back to yet");

  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(field, "Office Mac");
    field.dispatchEvent(new dom.Event("input", { bubbles: true }) as never);
  });
  await act(async () => { button("Save")!.click(); });
  await flush();
  assert.deepEqual(renamed, [["b".repeat(64), "Office Mac"]]);
  assert.equal(root.querySelector("form.mobile-connect-rename") === null, true, "the row comes back");
  assert.deepEqual(names(), ["studio", "Office Mac"]);

  // Saving the name it already has changes nothing.
  await rename(0);
  await act(async () => { button("Save")!.click(); });
  await flush();
  assert.equal(renamed.length, 1);

  await rename(1);
  assert.match(root.querySelector(".mobile-connect-rename-hint")?.textContent ?? "", /calls itself “mac-mini”/);
  await act(async () => { button("Use computer’s name")!.click(); });
  await flush();
  assert.deepEqual(renamed.at(-1), ["b".repeat(64), ""]);
  assert.deepEqual(names(), ["studio", "mac-mini"]);
});
