import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { Window } from "happy-dom";
import type { SlotRegistration, WebPackageHost } from "@polyth/web-sdk";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
let respond = async () => new Response(JSON.stringify({ title: "New title" }));
const requests: string[] = [];
globalThis.fetch = async (input, init) => {
  requests.push(String(input));
  assert.equal(init?.method, "POST");
  return respond();
};
register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: entry } = await import("../widgets/index.tsx");
const { friendlyError } = await import("../../../apps/web/src/settings.ts");

function fixture(locale = "en") {
  requests.length = 0;
  const slots = new Map<string, SlotRegistration>();
  let settingsRegistered = false;
  const host = {
    slots: { register(item: SlotRegistration) {
      slots.set(item.id, item);
      return () => { slots.delete(item.id); };
    } },
    settings: { registerPage() {
      settingsRegistered = true;
      return () => { settingsRegistered = false; };
    } },
    ui: { locale: { get: () => locale }, icons: {} },
    errors: { friendly: friendlyError },
  } as unknown as WebPackageHost;
  const install = entry(host);
  const dispose = install();
  const contribution = slots.get("custom-titles.regenerate")!;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let closed = 0;
  const render = (sessionId: string) => root.render(createElement("div", { role: "menu" },
    contribution.render({ sessionId, closeMenu: () => { closed += 1; } })));
  return {
    container, slots, install, dispose, contribution,
    settingsRegistered: () => settingsRegistered,
    closed: () => closed,
    mount: async (sessionId = "session") => act(async () => render(sessionId)),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      dispose();
    },
  };
}

test("the package registers its session menu action and disposes it with settings", async () => {
  const f = fixture();
  try {
    assert.equal(f.contribution.slot, "sidebar.session.actions");
    assert.equal(f.contribution.render({}), null);
    assert.equal(f.settingsRegistered(), true);
    f.dispose();
    assert.equal(f.slots.size, 0);
    assert.equal(f.settingsRegistered(), false);
    const disableAgain = f.install();
    assert.equal(f.slots.size, 2, "the row action and the selection action");
    disableAgain();
    assert.equal(f.slots.size, 0);
  } finally { await f.unmount(); }
});

test("regeneration targets the invoking session once, shows progress, and closes on success", async () => {
  const f = fixture("uk");
  let finish!: (value: Response) => void;
  respond = () => new Promise<Response>((resolve) => { finish = resolve; });
  try {
    await f.mount("session/id");
    const button = f.container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    assert.match(button.textContent ?? "", /Перегенерувати назву/);
    await act(async () => { button.click(); button.click(); });
    assert.deepEqual(requests, ["/api/custom-titles/sessions/session%2Fid/regenerate"]);
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute("aria-busy"), "true");
    assert.match(button.textContent ?? "", /Генеруємо назву/);
    assert.equal(f.closed(), 0);
    await act(async () => finish(new Response(JSON.stringify({ title: "Нова назва" }))));
    assert.equal(f.closed(), 1);
    assert.equal(button.disabled, false);
  } finally { await f.unmount(); }
});

test("failure keeps the menu usable and exposes a retryable error", async () => {
  const f = fixture();
  respond = async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
  try {
    await f.mount();
    const button = f.container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    await act(async () => button.click());
    assert.match(f.container.querySelector('[role="alert"]')?.textContent ?? "", /Couldn’t regenerate the title/);
    assert.equal(f.closed(), 0);
    assert.equal(button.disabled, false);
    respond = async () => new Response(JSON.stringify({ title: "Retried title" }));
    await act(async () => button.click());
    assert.equal(f.container.querySelector('[role="alert"]'), null);
    assert.equal(f.closed(), 1);
    assert.equal(requests.length, 2);
  } finally { await f.unmount(); }
});

test("a title taken from the message is reported as a note, not an error, and keeps the menu open", async () => {
  const f = fixture();
  respond = async () => new Response(JSON.stringify({ title: "Fix the login loop", fallback: true }));
  try {
    await f.mount();
    const button = f.container.querySelector<HTMLButtonElement>("button")!;
    await act(async () => button.click());
    assert.match(f.container.querySelector('[role="status"]')?.textContent ?? "", /didn’t return a usable title.*start of your message/);
    assert.ok(!f.container.querySelector('[role="alert"]'), "the title did change, so this is not a failure");
    assert.equal(f.closed(), 0);
    assert.equal(button.disabled, false);
    respond = async () => new Response(JSON.stringify({ title: "Model title" }));
    await act(async () => button.click());
    assert.ok(!f.container.querySelector('[role="status"]'), "the next attempt clears the note");
    assert.equal(f.closed(), 1);
  } finally { await f.unmount(); }
});

test("the degraded-result note follows the interface language", async () => {
  const f = fixture("uk");
  respond = async () => new Response(JSON.stringify({ title: "Нова назва", fallback: true }));
  try {
    await f.mount();
    await act(async () => f.container.querySelector<HTMLButtonElement>("button")!.click());
    assert.match(f.container.querySelector('[role="status"]')?.textContent ?? "", /Модель назв не повернула придатної назви/);
    assert.equal(f.closed(), 0);
  } finally { await f.unmount(); }
});

test("a generation failure shows its cause without a composer draft warning", async () => {
  const f = fixture();
  respond = async () => new Response(JSON.stringify({
    error: "timeout", message: "Title generation timed out. Try again, or choose another generator in Custom Titles settings.",
    operation: "title-regenerate", mutationOutcome: "not-started",
  }), { status: 504 });
  try {
    await f.mount();
    await act(async () => f.container.querySelector<HTMLButtonElement>("button")!.click());
    const error = f.container.querySelector('[role="alert"]')?.textContent ?? "";
    assert.match(error, /Title generation timed out/);
    assert.doesNotMatch(error, /draft|sending again/);
    assert.equal(f.closed(), 0);
  } finally { await f.unmount(); }
});

test("an uncertain rename tells the user to check the title without replaying the request", async () => {
  const f = fixture();
  respond = async () => new Response(JSON.stringify({
    error: "outcome-unknown",
    message: "The title change could not be confirmed. Check the session title before regenerating again.",
    operation: "title-regenerate", mutationOutcome: "unknown", retryability: "never",
  }), { status: 503 });
  try {
    await f.mount();
    await act(async () => f.container.querySelector<HTMLButtonElement>("button")!.click());
    const error = f.container.querySelector('[role="alert"]')?.textContent ?? "";
    assert.match(error, /Check the session title/);
    assert.doesNotMatch(error, /draft|sending again/);
    assert.equal(requests.length, 1);
    assert.equal(f.closed(), 0);
  } finally { await f.unmount(); }
});

test("a response for an unmounted session cannot close the new session's menu", async () => {
  const f = fixture();
  let finish!: (value: Response) => void;
  respond = () => new Promise<Response>((resolve) => { finish = resolve; });
  try {
    await f.mount("old-session");
    await act(async () => f.container.querySelector<HTMLButtonElement>("button")!.click());
    await f.mount("new-session");
    await act(async () => finish(new Response(JSON.stringify({ title: "Old session's title" }))));
    assert.equal(f.closed(), 0);
    assert.equal(f.container.querySelector<HTMLButtonElement>("button")!.disabled, false);
  } finally { await f.unmount(); }
});

test("the selection action regenerates every selected title and reports each refusal", async () => {
  const f = fixture();
  respond = async () => requests.at(-1)!.includes("no-message")
    ? new Response(JSON.stringify({ error: "invalid-input", code: "invalid-input" }), { status: 400 })
    : new Response(JSON.stringify({ title: "Title" }));
  const bulk = f.slots.get("custom-titles.regenerate-selected")!;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let closed = 0;
  let done = 0;
  let reported: { operation: string; succeeded: number; failed: Array<{ id: string; code: string }> } | null = null;
  let settle!: () => void;
  const reportedOnce = new Promise<void>((resolve) => { settle = resolve; });
  try {
    assert.equal(bulk.slot, "sidebar.sessions.bulk.actions");
    assert.equal(bulk.render({ sessionIds: [] }), null);
    await act(async () => root.render(createElement("div", { role: "menu" }, bulk.render({
      sessionIds: ["a", "no-message", "b", "c"],
      closeMenu: () => { closed += 1; },
      done: () => { done += 1; },
      report: (operation: string, succeeded: number, failed: Array<{ id: string; code: string }>) => {
        reported = { operation, succeeded, failed };
        settle();
      },
    }))));
    const button = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    assert.match(button.textContent ?? "", /Regenerate titles/);
    await act(async () => { button.click(); await reportedOnce; });
    assert.equal(closed, 1);
    assert.equal(done, 1);
    assert.deepEqual([...requests].sort(), [
      "/api/custom-titles/sessions/a/regenerate",
      "/api/custom-titles/sessions/b/regenerate",
      "/api/custom-titles/sessions/c/regenerate",
      "/api/custom-titles/sessions/no-message/regenerate",
    ]);
    assert.equal(reported!.succeeded, 3);
    assert.deepEqual(reported!.failed.map((failure) => failure.id), ["no-message"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await f.unmount();
  }
});
