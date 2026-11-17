// Previous-prompts palette (Ctrl/Cmd+Up, phone Add menu) and the cleared-draft
// restore: pure rules, the mounted palette and recall hook, and the Composer wiring.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { AttachmentRef, PromptHistoryEntryDto } from "@polyth/contracts";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "HTMLElement", {
  value: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  configurable: true,
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const history = await import("../src/composer/history.ts");
const cleared = await import("../src/composer/clearedDraft.ts");
const { usePromptHistory } = await import("../src/composer/usePromptHistory.ts");
const { addMenuRows } = await import("../src/composer/discovery.ts");
const { tr } = await import("../src/i18n/index.ts");
const { default: PromptHistoryPalette } = await import("../src/components/PromptHistoryPalette.tsx");

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");
const file = (name: string, path: string): AttachmentRef =>
  ({ id: name, name, mime: "text/plain", size: 4, kind: "file", path });
const entry = (id: string, text: string, over: Partial<PromptHistoryEntryDto> = {}): PromptHistoryEntryDto => ({
  id, text, sessionId: "s1", projectId: "p1", seq: 1, time: 1, attachments: [], ...over,
});
// The API lists a scope oldest first.
const ENTRIES = [
  entry("e1", "write the release notes", { seq: 1 }),
  entry("e2", "fix the flaky deploy test", { seq: 2, attachments: [file("trace.log", "trace.log")] }),
  entry("e3", "other project prompt", { seq: 3, projectId: "p2" }),
  entry("e4", "write the release notes", { seq: 4 }),
  entry("e5", "refactor the login form", { seq: 5 }),
];

// ---- shortcut and filtering rules ------------------------------------------

test("Ctrl/Cmd+Up opens the palette; plain, Alt, Shift and IME Up do not", () => {
  const base = { key: "ArrowUp", composing: false };
  assert.equal(history.isPromptHistoryPaletteKey({ ...base, ctrlKey: true }), true);
  assert.equal(history.isPromptHistoryPaletteKey({ ...base, metaKey: true }), true);
  assert.equal(history.isPromptHistoryPaletteKey({ ...base }), false);
  assert.equal(history.isPromptHistoryPaletteKey({ ...base, ctrlKey: true, altKey: true }), false);
  assert.equal(history.isPromptHistoryPaletteKey({ ...base, ctrlKey: true, shiftKey: true }), false);
  assert.equal(history.isPromptHistoryPaletteKey({ ...base, ctrlKey: true, composing: true }), false);
  assert.equal(history.isPromptHistoryPaletteKey({ key: "ArrowDown", composing: false, ctrlKey: true }), false);
  // Up-arrow recall keeps ignoring Ctrl/Cmd, so the two never both fire.
  assert.equal(history.shouldHandlePromptHistoryKey({ key: "ArrowUp", composing: false, ctrlKey: true }), false);
});

test("palette entries are this project's prompts, newest first, repeats once", () => {
  assert.deepEqual(history.paletteEntries(ENTRIES, "p1").map((e) => e.id), ["e5", "e4", "e2"]);
  assert.deepEqual(history.paletteEntries(ENTRIES, null).map((e) => e.id), ["e5", "e4", "e3", "e2"]);
});

test("filter keeps newest-first order and needs every typed word", () => {
  const all = history.paletteEntries(ENTRIES, "p1");
  assert.deepEqual(history.filterPromptHistory(all, "").map((e) => e.id), ["e5", "e4", "e2"]);
  assert.deepEqual(history.filterPromptHistory(all, "THE").map((e) => e.id), ["e5", "e4", "e2"]);
  assert.deepEqual(history.filterPromptHistory(all, "deploy flaky").map((e) => e.id), ["e2"]);
  assert.deepEqual(history.filterPromptHistory(all, "release login"), []);
});

// ---- mounted palette -------------------------------------------------------

let calls: Array<{ scope: string; limit: number }> = [];
const original = api.promptHistory;
before(() => {
  api.promptHistory = (async (q: { scope: "session" | "space"; limit: number }) => {
    calls.push({ scope: q.scope, limit: q.limit });
    return { entries: ENTRIES };
  }) as typeof api.promptHistory;
});
after(() => { api.promptHistory = original; });

const settle = async (ms = 10) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const rows = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];
const input = () => document.querySelector<HTMLInputElement>(".palette-input")!;
async function type(value: string) {
  await act(async () => {
    const el = input();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
const key = async (target: Element, k: string) => {
  await act(async () => {
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
};

async function mountPalette() {
  const picked: PromptHistoryEntryDto[] = [];
  let closed = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(PromptHistoryPalette, {
      projectId: "p1", onPick: (e: PromptHistoryEntryDto) => picked.push(e), onClose: () => { closed++; },
    }));
  });
  await settle();
  return {
    picked, closed: () => closed,
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

test("opens newest first for this project, filters as you type, Enter picks without sending", async () => {
  calls = [];
  const view = await mountPalette();
  assert.deepEqual(calls, [{ scope: "space", limit: 200 }]);
  assert.deepEqual(rows().map((r) => r.querySelector(".palette-label")!.textContent),
    ["refactor the login form", "write the release notes", "fix the flaky deploy test"]);
  assert.match(rows()[2]!.textContent ?? "", /1 attached/);
  assert.equal(input().getAttribute("aria-label"), tr("composer.historyPalette.search"));
  await type("deploy");
  assert.equal(rows().length, 1);
  await key(input(), "Enter");
  assert.deepEqual(view.picked.map((e) => e.id), ["e2"]);
  assert.equal(view.picked[0]!.attachments[0]!.name, "trace.log");
  await view.unmount();
});

test("arrows move the choice, a click picks, no match and Esc are handled", async () => {
  const view = await mountPalette();
  await key(input(), "ArrowDown");
  assert.equal(rows()[1]!.getAttribute("aria-selected"), "true");
  await key(input(), "Enter");
  assert.equal(view.picked.at(-1)!.id, "e4");
  await act(async () => { rows()[0]!.click(); });
  assert.equal(view.picked.at(-1)!.id, "e5");
  await type("zzz");
  assert.equal(rows().length, 0);
  assert.equal(document.querySelector(".palette-empty")!.textContent, tr("commandpalette.noMatches"));
  // Esc clears a typed query first and does not close yet. A second Esc is the
  // host Dialog's own close (focus trap + Escape), which the composer answers by
  // taking focus back (asserted on the wiring below; happy-dom cannot drive it).
  await key(input(), "Escape");
  assert.equal(input().value, "");
  assert.equal(view.closed(), 0);
  await view.unmount();
});

// ---- recall keeps attachments the way Up-arrow does --------------------------

test("recall puts text and recall-safe attachments in the composer; Esc returns to the draft", async () => {
  let hook!: ReturnType<typeof usePromptHistory>;
  function Probe() {
    hook = usePromptHistory({ sessionId: "s1", projectId: "p-other", scope: "space", limit: 50 });
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(createElement(Probe)); });
  await settle();
  const applied: Array<{ text: string; attachments: AttachmentRef[] }> = [];
  const draft = { text: "my draft that I was typing", attachments: [] as AttachmentRef[] };
  await act(async () => { hook.recall(ENTRIES[1]!, draft, (d) => applied.push(d)); });
  // Another project's file path is dropped, never silently re-pointed.
  assert.equal(applied[0]!.text, "fix the flaky deploy test");
  assert.equal(applied[0]!.attachments[0]!.name, "trace.log");
  assert.equal(applied[0]!.attachments[0]!.path, undefined);
  assert.equal(hook.isBrowsing(), true);
  await act(async () => { hook.cancelToDraft((d) => applied.push(d)); });
  assert.equal(applied[1]!.text, draft.text);
  assert.equal(hook.isBrowsing(), false);
  await act(async () => { root.unmount(); });
});

// ---- phone entry point -------------------------------------------------------

test("the Add menu offers Previous prompts (the phone's way in) and the composer opens it", async () => {
  const menu = addMenuRows({
    hasProject: true, hasSession: true, draftText: "",
    commands: { state: "empty" }, snippets: { state: "empty" },
  });
  const row = menu.find((r) => r.id === "history");
  assert.equal(row?.action, "history");
  assert.equal(row?.label, tr("composer.historyPalette.title"));
  assert.equal(row?.disabledReason, undefined);
  assert.equal(menu.find((r) => r.id === "history")?.hint, history.promptHistoryShortcutLabel());
  const noProject = addMenuRows({ hasProject: false, hasSession: false, draftText: "", commands: { state: "loading" }, snippets: { state: "loading" } });
  assert.ok(noProject.find((r) => r.id === "history")?.disabledReason);
  const addMenu = await read("../src/components/ComposerAddMenu.tsx");
  assert.ok(addMenu.includes('case "history": props.onOpenHistory()'));
  const composer = await read("../src/components/Composer.tsx");
  assert.ok(composer.includes("onOpenHistory={() => setHistoryOpen(true)}"));
  assert.ok(composer.includes("isPromptHistoryPaletteKey({"));
  assert.ok(composer.includes("<PromptHistoryPalette"));
  assert.ok(composer.includes("onClose={() => { setHistoryOpen(false); inputRef.current?.focus(); }}"), "Esc/close returns focus to the composer");
});

// ---- cleared-draft restore ---------------------------------------------------

const LONG = "a draft long enough to be worth keeping";
test("a real draft that empties without a send is captured; short ones and sends are not", () => {
  const now = 1_000;
  assert.deepEqual(cleared.captureClearedDraft({ prev: LONG, next: "", lastSent: null, now }), { text: LONG, at: now });
  assert.deepEqual(cleared.captureClearedDraft({ prev: LONG, next: "  \n", lastSent: null, now }), { text: LONG, at: now });
  assert.equal(cleared.captureClearedDraft({ prev: "short draft", next: "", lastSent: null, now }), null);
  assert.equal(cleared.captureClearedDraft({ prev: "x".repeat(19), next: "", lastSent: null, now }), null);
  assert.notEqual(cleared.captureClearedDraft({ prev: "x".repeat(20), next: "", lastSent: null, now }), null);
  assert.equal(cleared.captureClearedDraft({ prev: LONG, next: "part", lastSent: null, now }), null);
  // The field emptying after a send is never a loss.
  assert.equal(cleared.captureClearedDraft({ prev: LONG, next: "", lastSent: ` ${LONG} `, now }), null);
});

test("the offer lasts 10 s and 20 typed characters dismiss it", () => {
  const draft = { text: LONG, at: 5_000 };
  assert.equal(cleared.clearedDraftLive(draft, 5_000 + 9_999), true);
  assert.equal(cleared.clearedDraftLive(draft, 5_000 + 10_000), false);
  assert.equal(cleared.clearedDraftLive(null, 5_000), false);
  assert.equal(cleared.typingDismissesClearedDraft("x".repeat(19)), false);
  assert.equal(cleared.typingDismissesClearedDraft("x".repeat(20)), true);
});

test("Cmd/Ctrl+Z restores; Shift+Z, Alt+Z and a bare Z do not", () => {
  assert.equal(cleared.isRestoreUndoKey({ key: "z", ctrlKey: true }), true);
  assert.equal(cleared.isRestoreUndoKey({ key: "Z", metaKey: true }), true);
  assert.equal(cleared.isRestoreUndoKey({ key: "z", metaKey: true, shiftKey: true }), false);
  assert.equal(cleared.isRestoreUndoKey({ key: "z", ctrlKey: true, altKey: true }), false);
  assert.equal(cleared.isRestoreUndoKey({ key: "z" }), false);
});

test("the composer wires the restore: user edits only, send and a new chat dismiss, quiet pending-stack line", async () => {
  const composer = await read("../src/components/Composer.tsx");
  assert.ok(composer.includes('if (source === "user" && !restoringDraftRef.current)'), "only the person's own edit can lose a draft");
  assert.ok(composer.includes("typingDismissesClearedDraft(val)"), "typing dismisses");
  assert.ok(composer.includes("if (!parkAsDraft && clearedDraftRef.current) setClearedDraft(null)"), "send dismisses");
  assert.ok(composer.includes("isRestoreUndoKey(e)"), "Cmd/Ctrl+Z restores");
  assert.ok(composer.includes("[session?.id, setClearedDraft]"), "another chat drops the offer");
  assert.ok(composer.includes('className="composer-suggestion composer-restore"'), "one line on the suggestion grid");
  const input = await read("../src/components/input/AdaptiveTextInput.tsx");
  assert.ok(input.includes('onTextChange?.(el.value, "program")'), "programmatic replaces are labelled");
  assert.equal((input.match(/"user"\)/g) ?? []).length, 3, "typing, composition end and reconcile are the person's");
});

test("copy exists in every locale", async () => {
  for (const lang of ["en", "uk", "de", "fr", "es", "it", "pl", "pt", "pt-BR", "bg", "ar", "zh-CN"]) {
    const src = await read(`../src/i18n/locales/${lang}.ts`);
    for (const k of ["composer.historyPalette.title", "composer.restoreDraft.action"]) {
      assert.ok(src.includes(`"${k}"`), `${lang} has ${k}`);
    }
  }
  assert.equal(tr("composer.restoreDraft.action"), "Restore draft");
});
