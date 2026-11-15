import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Element: dom.Element, Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  location: dom.location, history: dom.history, getComputedStyle: dom.getComputedStyle.bind(dom),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (cb: FrameRequestCallback) => { cb(0); return 1; } });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
Object.defineProperty(dom, "matchMedia", { configurable: true, value: () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} }) });

type Settings = { mode: string; model?: unknown; style?: Record<string, unknown> };
let stored: { revision: number; settings: Settings; canEdit: boolean } = { revision: 1, settings: { mode: "session" }, canEdit: true };
let putFails: "conflict" | "forbidden" | null = null;
const puts: Array<{ settings: Settings; expectedRevision: number }> = [];
const respond = (body: unknown, status = 200) => ({
  ok: status < 400, status, statusText: status < 400 ? "OK" : "Conflict",
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body, text: async () => JSON.stringify(body),
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/git/commit-settings")) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { settings: Settings; expectedRevision: number };
        puts.push(body);
        if (putFails === "conflict") return respond({ error: "Commit settings changed elsewhere. Reload settings.", code: "conflict" }, 409);
        if (putFails === "forbidden") return respond({ error: "Only a Space admin can change how commit messages are written.", code: "permission-denied" }, 403);
        stored = { revision: stored.revision + 1, settings: body.settings, canEdit: true };
        const { canEdit: _canEdit, ...saved } = stored;
        void _canEdit;
        return respond(saved);
      }
      return respond(stored);
    }
    if (url.includes("/api/harnesses/snapshots")) return respond([]);
    return respond({});
  },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: CommitMessageSettings, matchCommitStyle } = await import("../widgets/CommitMessageSettings.tsx");
const { tr } = await import("../../../apps/web/src/i18n/index.ts");

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 2)); }); };

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(CommitMessageSettings, {})); });
  await flush();
  const q = <T extends Element>(selector: string) => container.querySelector(selector) as T | null;
  const type = async (selector: string, value: string) => {
    const field = q<HTMLTextAreaElement>(selector)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    });
    await flush();
  };
  const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
  const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); await flush(); };
  const pickStyle = async (label: string) => {
    const trigger = [...container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")?.includes(tr("gitsettings.commitStyleMenu")));
    assert.ok(trigger, "style select trigger");
    await click(trigger as HTMLElement);
    const option = [...document.querySelectorAll("[role=option]")].find((o) => o.textContent?.includes(label));
    assert.ok(option, `style option ${label}`);
    await click(option as HTMLElement);
  };
  const unmount = async () => { await act(async () => { root.unmount(); }); container.remove(); };
  return { container, q, type, button, click, pickStyle, unmount };
}

const reset = (settings: Settings = { mode: "session" }, canEdit = true) => {
  stored = { revision: 1, settings, canEdit };
  putFails = null;
  puts.length = 0;
};

test("ready-made styles are recognised from their text, anything else is the person's own", () => {
  assert.equal(matchCommitStyle({ titleRule: "", detailsRule: "" }), "standard");
  assert.equal(matchCommitStyle({ titleRule: ` ${tr("gitsettings.commitTemplateBracketsTitle")}\n`, detailsRule: tr("gitsettings.commitTemplateBracketsDetails") }), "brackets");
  assert.equal(matchCommitStyle({ titleRule: tr("gitsettings.commitTemplateConventionalTitle"), detailsRule: tr("gitsettings.commitTemplateConventionalDetails") }), "conventional");
  assert.equal(matchCommitStyle({ titleRule: "Lowercase titles.", detailsRule: "" }), null);
});

test("an admin edits the rules as a draft and saves them once, in full", async () => {
  reset();
  const view = await mount();
  try {
    assert.equal(view.q("#git-commit-title-rule"), null, "Standard keeps the rule fields folded");
    assert.equal(view.q("#git-commit-details-rule"), null);
    assert.equal(view.button(tr("settings.parts.save"))?.disabled, true, "nothing to save yet");
    assert.match(view.container.textContent ?? "", new RegExp(tr("gitsettings.commitStyleStandard")));
    await view.pickStyle(tr("gitsettings.commitStyleOwn"));
    assert.ok(view.q("#git-commit-title-rule"), "own rules open the title field");
    assert.ok(view.q("#git-commit-details-rule"), "and the details field");
    await view.type("#git-commit-title-rule", "Start with [Fix] or [Feature].");
    assert.equal(puts.length, 0, "typing never saves");
    assert.match(view.container.textContent ?? "", new RegExp(tr("gitsettings.commitStyleOwn")));
    assert.match(view.container.textContent ?? "", new RegExp(tr("gitsettings.commitExampleOwn").slice(0, 20)));
    await view.click(view.button(tr("settings.parts.save"))!);
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0], {
      expectedRevision: 1,
      settings: { mode: "session", style: { titleRule: "Start with [Fix] or [Feature].", detailsRule: "", details: "auto", matchHistory: false } },
    });
    assert.equal(view.button(tr("settings.parts.save"))?.disabled, true, "saved draft is clean");
  } finally { await view.unmount(); }
});

test("choosing Never hides the details rule but keeps its text", async () => {
  reset({ mode: "small", style: { titleRule: "", detailsRule: "Bullets only.", details: "always", matchHistory: true } });
  const view = await mount();
  try {
    assert.equal(view.q<HTMLTextAreaElement>("#git-commit-details-rule")?.value, "Bullets only.");
    await view.click(view.button(tr("gitsettings.commitDetailsNever"))!);
    assert.equal(view.q("#git-commit-details-rule"), null);
    await view.click(view.button(tr("gitsettings.commitDetailsAlways"))!);
    assert.equal(view.q<HTMLTextAreaElement>("#git-commit-details-rule")?.value, "Bullets only.");
  } finally { await view.unmount(); }
});

test("a member sees the Space's rules read-only, without controls", async () => {
  reset({ mode: "session", style: { titleRule: "Lowercase titles.", detailsRule: "", details: "never", matchHistory: false } }, false);
  const view = await mount();
  try {
    assert.equal(view.q("textarea"), null);
    assert.equal(view.button(tr("settings.parts.save")), undefined);
    assert.equal(view.q(".settings-reset-link"), null, "no Reset for a member");
    const text = view.container.textContent ?? "";
    assert.match(text, /Lowercase titles\./);
    assert.match(text, new RegExp(tr("gitsettings.commitMessagesReadonly")));
    assert.match(text, new RegExp(tr("gitsettings.commitDetailsNever")));
    assert.doesNotMatch(text, new RegExp(tr("gitsettings.commitDetailsRule")), "no details rule row when details are off");
  } finally { await view.unmount(); }
});

test("choosing a ready-made style fills both rules", async () => {
  reset();
  const view = await mount();
  try {
    await view.pickStyle(tr("gitsettings.commitStyleBrackets"));
    assert.equal(view.q<HTMLTextAreaElement>("#git-commit-title-rule")?.value, tr("gitsettings.commitTemplateBracketsTitle"));
    assert.equal(view.q<HTMLTextAreaElement>("#git-commit-details-rule")?.value, tr("gitsettings.commitTemplateBracketsDetails"));
    assert.match(view.container.querySelector(".git-commit-example pre")?.textContent ?? "", /^\[Fix\] Sign-in on slow connections/);
    await view.click(view.button(tr("settings.parts.discard"))!);
    assert.equal(view.q("#git-commit-title-rule"), null, "Discard folds back to Standard");
  } finally { await view.unmount(); }
});

test("a refused save says only admins can change it", async () => {
  reset({ mode: "session", style: { titleRule: "Old.", detailsRule: "", details: "auto", matchHistory: false } });
  const view = await mount();
  try {
    putFails = "forbidden";
    await view.type("#git-commit-title-rule", "New.");
    await view.click(view.button(tr("settings.parts.save"))!);
    assert.match(view.container.textContent ?? "", new RegExp(tr("gitsettings.commitMessagesReadonly")));
    assert.equal(view.q<HTMLTextAreaElement>("#git-commit-title-rule")?.value, "New.");
  } finally { await view.unmount(); }
});

test("a conflicting save keeps the draft and offers to reload", async () => {
  reset({ mode: "session", style: { titleRule: "Old.", detailsRule: "", details: "auto", matchHistory: false } });
  const view = await mount();
  try {
    putFails = "conflict";
    await view.type("#git-commit-title-rule", "Mine.");
    await view.click(view.button(tr("settings.parts.save"))!);
    assert.equal(view.q<HTMLTextAreaElement>("#git-commit-title-rule")?.value, "Mine.", "the draft survives a failed save");
    assert.match(view.container.textContent ?? "", new RegExp(tr("gitsettings.saveConflict").slice(0, 25)));
    putFails = null;
    stored = { revision: 5, settings: { mode: "session", style: { titleRule: "Theirs.", detailsRule: "", details: "auto", matchHistory: false } }, canEdit: true };
    await view.click(view.button(tr("gitsettings.commitReload"))!);
    assert.equal(view.q<HTMLTextAreaElement>("#git-commit-title-rule")?.value, "Theirs.");
  } finally { await view.unmount(); }
});
