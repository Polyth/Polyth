// The desktop app's server list and the switcher that says which Polyth the
// window shows. The bridge is faked: the main process's side is covered in
// apps/desktop/test, and the two meet in the live test recipe in docs/dev/desktop.md.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "polyth-app://hub/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
for (const name of ["navigator", "localStorage", "sessionStorage", "location"] as const) {
  Object.defineProperty(globalThis, name, { value: dom[name], configurable: true });
}
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});
Object.assign(globalThis, { matchMedia: (dom as unknown as { matchMedia: unknown }).matchMedia });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { register } = await import("node:module");
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { DesktopServerList, desktopLinkAdapter } = await import("../src/components/DesktopServerList.tsx");
const { default: DesktopServerSwitcher } = await import("../src/components/DesktopServerSwitcher.tsx");
const { localDesktopBridge, onRemoteDesktopSurface } = await import("../src/desktopBridge.ts");

type Call = { method: string; args: unknown[] };

function fakeServers(overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {}) {
  const calls: Call[] = [];
  const view = {
    active: { kind: "local" as const },
    runLocalServer: true,
    local: "running" as const,
    linkAvailable: true,
    addresses: [{ url: "https://polyth.example.com", lastUsedAt: 1 }],
  };
  const record = (method: string, fallback: (...args: unknown[]) => unknown) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return (overrides[method] ?? fallback)(...args);
  };
  const servers = {
    menu: record("menu", () => undefined),
    list: record("list", () => undefined),
    resume: record("resume", () => undefined),
    state: record("state", () => view),
    open: record("open", () => ({ ok: true, result: undefined })),
    link: record("link", (method) => {
      if (method === "connections.list") return { ok: true, result: [] };
      return { ok: false, code: "unavailable" };
    }),
    forgetAddress: record("forgetAddress", () => view),
    setRunLocalServer: record("setRunLocalServer", () => view),
  };
  return { servers, calls };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function mount(servers: ReturnType<typeof fakeServers>["servers"], search = "") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(DesktopServerList as never, { servers, query: new URLSearchParams(search) } as never));
  });
  await flush();
  return { host, unmount: () => act(async () => { root.unmount(); }) };
}

const button = (host: Element, text: string) =>
  [...host.querySelectorAll("button")].find((item) => (item.textContent ?? "").includes(text)) as HTMLButtonElement | undefined;

async function submitAdd(host: Element, value: string): Promise<void> {
  const input = host.querySelector("#desktop-servers-add-input") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  await act(async () => {
    host.querySelector("form.desktop-servers-add")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  await flush();
}

test("the list offers this computer, saved addresses and a way to add one", async () => {
  const { servers } = fakeServers();
  const { host, unmount } = await mount(servers);
  const text = host.textContent ?? "";
  assert.match(text, /This computer/);
  assert.match(text, /Running here/);
  assert.match(text, /polyth\.example\.com/);
  assert.equal(host.querySelector("#desktop-servers-add-input") !== null, true);
  await unmount();
});

test("an address goes to the main process, which does the checking", async () => {
  const { servers, calls } = fakeServers();
  const { host, unmount } = await mount(servers);
  await submitAdd(host, "https://other.example.com");
  assert.deepEqual(calls.find((call) => call.method === "open")?.args, [{ kind: "address", url: "https://other.example.com" }]);
  await unmount();
});

test("a refused address stays on the list with its reason", async () => {
  const { servers } = fakeServers({ open: () => ({ ok: false, code: "not-polyth" }) });
  const { host, unmount } = await mount(servers);
  await submitAdd(host, "https://not-polyth.example.com");
  assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", /isn't a Polyth server/);
  await unmount();
});

test("a build without the Link client refuses a pairing link instead of pretending", async () => {
  const { servers, calls } = fakeServers({
    state: () => ({ active: { kind: "local" }, runLocalServer: true, local: "running", linkAvailable: false, addresses: [] }),
  });
  const { host, unmount } = await mount(servers);
  await submitAdd(host, "polyth://pair?v=1&t=abc");
  assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", /can't pair through Polyth Link/);
  assert.equal(calls.some((call) => call.method === "link" && call.args[0] === "pairing.begin"), false);
  await unmount();
});

test("nearby pairing is refused: the desktop app has no local discovery", async () => {
  const { servers } = fakeServers();
  await assert.rejects(desktopLinkAdapter(servers as never).beginNumericPairing({ code: "123456" } as never), { code: "unavailable" });
});

const withBridge = async (bridge: unknown, run: () => Promise<void>): Promise<void> => {
  (dom as unknown as { polythDesktop?: unknown }).polythDesktop = bridge;
  try {
    await run();
  } finally {
    delete (dom as unknown as { polythDesktop?: unknown }).polythDesktop;
  }
};

async function mountSwitcher() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(DesktopServerSwitcher)); });
  await flush();
  return { host, unmount: () => act(async () => { root.unmount(); }) };
}

test("the window says which server it shows when that server is elsewhere, and opens the native menu", async () => {
  const { servers, calls } = fakeServers();
  const getInfo = async () => ({ server: { kind: "link", label: "Studio Mac" } });
  await withBridge({ surface: "remote", servers, getInfo }, async () => {
    const { host, unmount } = await mountSwitcher();
    const chip = host.querySelector(".desktop-server-switcher") as HTMLButtonElement | null;
    assert.equal(chip !== null, true);
    assert.match(chip?.textContent ?? "", /Studio Mac/);
    assert.equal(chip?.getAttribute("aria-haspopup"), "menu");
    await act(async () => { chip?.click(); });
    assert.equal(calls.some((call) => call.method === "menu"), true);
    await unmount();
  });
});

test("this computer's own page and browsers show no switcher", async () => {
  const { servers } = fakeServers();
  await withBridge({ surface: "local", servers, getInfo: async () => ({ server: { kind: "local", label: "This computer" } }) }, async () => {
    const { host, unmount } = await mountSwitcher();
    assert.equal(host.querySelector(".desktop-server-switcher") === null, true);
    await unmount();
  });
  const { host, unmount } = await mountSwitcher();
  assert.equal(host.querySelector(".desktop-server-switcher") === null, true);
  await unmount();
});

test("this computer's authority is offered only on this computer's own page", async () => {
  const bridge = { surface: "local" };
  await withBridge(bridge, async () => {
    assert.equal(localDesktopBridge() === undefined, false);
    assert.equal(onRemoteDesktopSurface(), false);
  });
  await withBridge({ surface: "remote" }, async () => {
    assert.equal(localDesktopBridge() === undefined, true);
    assert.equal(onRemoteDesktopSurface(), true);
  });
  await withBridge({ surface: "hub" }, async () => {
    assert.equal(localDesktopBridge() === undefined, true);
  });
  // A shell older than client mode is always on this computer's server.
  await withBridge({}, async () => {
    assert.equal(localDesktopBridge() === undefined, false);
  });
  await withBridge({ surface: null }, async () => {
    assert.equal(localDesktopBridge() === undefined, true, "a page the main process does not know has no authority");
  });
});
