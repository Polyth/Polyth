// "Sync appearance with server" separates this device's look from the account's.
// On the desktop shell that runs this computer's own server there is no second
// side, so the row (and its search hit) exists only for clients: a browser, the
// native app, or a desktop window showing a remote/Link server.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost/", width: 1280, height: 900 });
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, getComputedStyle: dom.getComputedStyle.bind(dom),
  matchMedia: dom.matchMedia.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppearancePage } = await import("../src/components/settings/pages.tsx");
const { onServerHostSurface } = await import("../src/desktopBridge.ts");
const { searchSettingsItems } = await import("../src/settings/registry.ts");
const { tr } = await import("../src/i18n/index.ts");

type Shell = { surface?: "local" | "hub" | "remote" | null } | undefined;
const host = dom as unknown as { polythDesktop?: Shell };
const setShell = (shell: Shell) => {
  if (shell === undefined) delete host.polythDesktop;
  else host.polythDesktop = shell;
};

const hit = () => searchSettingsItems(tr("settings.pages.syncAppearance"), { appearance: tr("settings.pages.appearance") })
  .find((entry) => entry.item.id === "appearance.sync");

async function mount() {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const flush = async () => {
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  const render = async () => {
    await act(async () => root.render(createElement(AppearancePage)));
    await flush();
  };
  await render();
  return {
    row: () => host.querySelector('[data-settings-item="appearance.sync"]'),
    async rerender() { await render(); },
    async unmount() { await act(async () => root.unmount()); host.remove(); },
  };
}

test("only a client surface offers per-device appearance sync", async () => {
  setShell(undefined);
  assert.equal(onServerHostSurface(), false, "a plain browser window is a client");

  const view = await mount();
  try {
    assert.ok(view.row(), "a browser shows the sync row");
    assert.ok(hit(), "and its search hit");

    // A desktop window on this computer's own server: the row has no meaning.
    setShell({ surface: "local" });
    assert.equal(onServerHostSurface(), true);
    await view.rerender();
    assert.equal(view.row(), null, "the server host does not show the sync row");
    assert.equal(hit(), undefined, "nor a dead search hit");

    // Older shells have no surface field; they are always this computer's server.
    setShell({});
    assert.equal(onServerHostSurface(), true);
    await view.rerender();
    assert.equal(view.row(), null);

    // A desktop window showing another Polyth is a client again.
    setShell({ surface: "remote" });
    assert.equal(onServerHostSurface(), false);
    await view.rerender();
    assert.ok(view.row(), "a remote/Link window shows the sync row");
    assert.ok(hit());

    // An unplaceable origin (main.ts's `null`: a dropped Link address, a
    // redirect, an IPC failure) is a client this build cannot classify, so it
    // keeps the client's row rather than losing the choice.
    setShell({ surface: null });
    assert.equal(onServerHostSurface(), false);
    await view.rerender();
    assert.ok(view.row(), "an unknown surface keeps the sync row");
    assert.ok(hit());

    // The bundled server list is neither host nor client, but it only ever
    // renders DesktopServerList, never Settings.
    setShell({ surface: "hub" });
    assert.equal(onServerHostSurface(), false);
  } finally {
    setShell(undefined);
    await view.unmount();
  }
});
