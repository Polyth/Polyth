// Mounted Settings → Google: one sign-in button asks for everything the app
// offers, Allow offers only what that app may request, the own client sits
// under Advanced, a first-time admin sets up from Google's client file, and a
// pasted redirect address finishes the sign-in by itself.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { WebPackageHost } from "@polyth/web-sdk";

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
const { default: GoogleSettingsPage, clientFromGoogleFile } = await import("../widgets/GoogleSettingsPage.tsx");
const { translateEnglish } = await import("../widgets/i18n.ts");
const { googleLocales } = await import("../src/i18n/index.ts");

const BUILTIN = ["calendar.read", "calendar.write", "gmail.send", "drive.file"];
const snapshot = {
  client: { configured: true, source: "builtin", clientId: "123-polyth.apps.googleusercontent.com", hasSecret: true, capabilities: BUILTIN },
  accounts: [{
    id: "1001", email: "ada@example.com", name: "Ada", status: "connected",
    capabilities: ["gmail.send", "calendar.read", "calendar.write"], scopes: [], connectedAt: 0, updatedAt: 0, enabled: true,
  }],
  service: [],
  policy: { agentsMayUseService: false },
  canManage: true,
};

const json = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } });
const pendingFlow = (n: number) => ({ state: `state-${n}-0123456789abcdef`, status: "pending", url: "https://accounts.google.com/o/oauth2/v2/auth", redirectUri: "http://127.0.0.1:5000/", expiresAt: Date.now() + 60_000 });

async function mount(t: { after(fn: () => unknown): void }, route: (path: string, init?: RequestInit) => Response | undefined, host: WebPackageHost = {} as WebPackageHost) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const response = route(path, init);
    if (!response) throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
    return response;
  }) as typeof fetch;
  const originalOpen = dom.open;
  dom.open = (() => null) as typeof dom.open;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    dom.open = originalOpen;
  });
  const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
  const button = (text: string) => [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  const click = async (text: string) => {
    const target = button(text);
    assert.ok(target, `button "${text}"`);
    await act(async () => { target.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
    await flush();
  };
  await act(async () => { root.render(createElement(GoogleSettingsPage, { host })); });
  await flush();
  return { container, button, click, flush };
}

test("the built-in app signs in with one button and keeps the own client under Advanced", async (t) => {
  const posted: unknown[] = [];
  const view = await mount(t, (path, init) => {
    if (path === "/api/google/connect" && init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      return json(pendingFlow(posted.length));
    }
    if (path.startsWith("/api/google/connect/") && init?.method === "DELETE") return json({ status: "cancelled" });
    if (path === "/api/google") return json(snapshot);
    return undefined;
  });
  const text = view.container.textContent ?? "";
  assert.match(text, /Send only/);
  assert.match(text, /Agents cannot read your mailbox/);
  assert.doesNotMatch(text, /Client ID|OAuth/, "nothing technical before Advanced is opened");
  // Gmail and Calendar already hold everything the built-in app may ask for;
  // only Drive offers more, and only its file-only level.
  assert.equal([...view.container.querySelectorAll("button")].filter((item) => item.textContent?.trim() === "Allow").length, 1);

  await view.click("Allow");
  assert.deepEqual(posted.at(-1), { capabilities: ["drive.file"], owner: "person", accountId: "1001" });
  await view.click("Cancel");
  await view.click("Add another account");
  assert.deepEqual(posted.at(-1), { capabilities: BUILTIN, owner: "person" });
  await view.click("Cancel");

  await view.click("Show");
  assert.match(view.container.textContent ?? "", /Google app.*Polyth/);
  assert.ok(view.button("Use your own Google app"), "the own client is an Advanced action");
});

test("a pasted Google address finishes the sign-in by itself, and a failure offers Try again", async (t) => {
  const posted: unknown[] = [];
  const completed: unknown[] = [];
  let failNext = true;
  const empty = { ...snapshot, accounts: [] };
  const view = await mount(t, (path, init) => {
    if (path === "/api/google/connect" && init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      return json(pendingFlow(posted.length));
    }
    const complete = path.match(/^\/api\/google\/connect\/(state-\d+-0123456789abcdef)\/complete$/);
    if (complete && init?.method === "POST") {
      completed.push(JSON.parse(String(init.body)));
      const failed = failNext;
      failNext = false;
      return json(failed
        ? { ...pendingFlow(posted.length), status: "failed", error: { code: "not-configured", message: "This Google app's client secret is missing." } }
        : { ...pendingFlow(posted.length), status: "completed", email: "ada@example.com" });
    }
    if (path === "/api/google") return json(empty);
    return undefined;
  });
  await view.click("Sign in with Google");
  assert.deepEqual(posted.at(-1), { capabilities: BUILTIN, owner: "person" });
  assert.match(view.container.textContent ?? "", /Waiting for Google/);
  // This browser is the server's own machine, so pasting is offered, not pushed.
  assert.equal(view.container.querySelector("input"), null);
  await view.click("Signed in on another device?");
  const input = view.container.querySelector("input")!;
  const address = "http://127.0.0.1:5000/?state=state-1-0123456789abcdef&code=4/abc";
  const paste = new dom.Event("paste", { bubbles: true, cancelable: true }) as unknown as Event & { clipboardData: unknown };
  Object.defineProperty(paste, "clipboardData", { value: { getData: () => address } });
  await act(async () => { input.dispatchEvent(paste); });
  await view.flush();
  assert.deepEqual(completed, [{ url: address }], "no Finish click needed");
  assert.match(view.container.textContent ?? "", /Sign-in not finished.*client secret is missing/);

  await view.click("Try again");
  assert.deepEqual(posted.at(-1), { capabilities: BUILTIN, owner: "person" });
  assert.equal(posted.length, 2);
});

test("a first-time admin sets Google up from the file Google gives for the client", async (t) => {
  const puts: unknown[] = [];
  let configured = false;
  const view = await mount(t, (path, init) => {
    if (path === "/api/google/client" && init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)));
      configured = true;
      return json({});
    }
    if (path === "/api/google") {
      return json(configured
        ? { ...snapshot, accounts: [], client: { configured: true, source: "space", clientId: "123-own.apps.googleusercontent.com", hasSecret: true, capabilities: ["gmail.read"] } }
        : { ...snapshot, accounts: [], client: { configured: false, hasSecret: false, capabilities: [] } });
    }
    return undefined;
  });
  const text = view.container.textContent ?? "";
  assert.match(text, /Set up Google once/);
  assert.equal(view.container.querySelectorAll(".google-setup-step").length, 5);
  assert.ok([...view.container.querySelectorAll("a")].some((link) => link.getAttribute("href")?.includes("enableapi")), "step links open Google Cloud");
  assert.equal(view.button("Sign in with Google"), undefined);

  const file = new dom.File([JSON.stringify({ installed: { client_id: "123-own.apps.googleusercontent.com", client_secret: "GOCSPX-x", redirect_uris: ["http://localhost"] } })], "client_secret_123.json", { type: "application/json" });
  const picker = view.container.querySelector("input[type=file]") as unknown as { files: unknown; dispatchEvent(event: Event): boolean };
  Object.defineProperty(picker, "files", { value: [file], configurable: true });
  await act(async () => { picker.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event); });
  await view.flush();
  await view.flush();
  assert.deepEqual(puts, [{ clientId: "123-own.apps.googleusercontent.com", clientSecret: "GOCSPX-x" }]);
  assert.ok(view.button("Sign in with Google"), "the next step is signing in");
});

test("Google's client file is read for a Desktop app client only", () => {
  const t = translateEnglish;
  assert.deepEqual(clientFromGoogleFile(JSON.stringify({ installed: { client_id: "1-a.apps.googleusercontent.com", client_secret: "s" } }), t), { clientId: "1-a.apps.googleusercontent.com", clientSecret: "s" });
  assert.throws(() => clientFromGoogleFile(JSON.stringify({ web: { client_id: "1-a.apps.googleusercontent.com", client_secret: "s" } }), t), /Desktop app/);
  assert.throws(() => clientFromGoogleFile("not json", t), /not the file/);
  assert.throws(() => clientFromGoogleFile(JSON.stringify({ installed: { client_id: "1-a.apps.googleusercontent.com" } }), t), /not the file/);
});

const fillUk = (key: string, values?: Record<string, string | number>): string =>
  (googleLocales.uk[key as keyof typeof googleLocales.uk] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => values && name in values ? String(values[name]) : match);

test("the page follows the interface language", async (t) => {
  const view = await mount(t, (path) => path === "/api/google" ? json({ ...snapshot, accounts: [] }) : undefined, { ui: { locale: { get: () => "uk", translate: (key: string, values?: Record<string, string | number>) => fillUk(key, values) } } } as unknown as WebPackageHost);
  assert.ok(view.button("Увійти через Google"));
  assert.match(view.container.textContent ?? "", /Ваш обліковий запис Google/);
});
