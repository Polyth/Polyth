// The Memory page as a person uses it: open a record from the list, edit and
// save it, step back with Escape, search, filter, load more, and the chips
// list field. Mounted without a host, so every control is its plain element.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project } from "@polyth/contracts";
import { memoryApi, personalMemoryApi, type MemoryDto, type MemoryListItem, type MemoryPolicy } from "../src/client.ts";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
// The utility-model picker reads the harness catalog on mount: nothing here.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: MemorySettings } = await import("../widgets/MemorySettings.tsx");
const { default: MyNotes } = await import("../widgets/MyNotes.tsx");

const policy = {
  mode: "auto", generation: "g1", settingsRevision: "1", updatedAt: 0,
  contextBudget: { maxRecords: 6, maxBytes: 6144 }, harvesting: "paused",
  utilityAllowlist: [], utilityStatus: "disabled", utilityModelAllowed: false, consentRequired: true,
  utilityBudget: { maxCalls: 0, usedCalls: 0, reservedCalls: 0, remainingCalls: 0 },
  blockWithoutMemory: false, reviewPolicy: "low-risk-auto-active", exclusions: { sessions: [], sources: [], paths: [] },
} as MemoryPolicy;
const now = Date.now();
const record = (index: number, extra: Partial<MemoryDto> = {}): MemoryDto => ({
  id: `m${index}`, projectId: "p", title: `Record ${index}`, body: `Full body of record ${index}. It is longer than its snippet.`,
  category: "decision", tags: ["release"], aliases: [], applicability: {}, sources: [], lifecycle: "active",
  evidence: "user-stated", freshness: "current", pinned: false, userLocked: false, revision: 3, createdAt: now - 86_400_000, updatedAt: now - 3_600_000,
  ...extra,
});
const itemOf = ({ body, sources: _sources, applicability: _applicability, ...rest }: MemoryDto): MemoryListItem => ({ ...rest, snippet: body.slice(0, 18), bodyBytes: body.length, sourceCount: 0 });
const harvested = record(1, {
  sources: [{ kind: "session", sessionId: "s-1", startSeq: 4, endSeq: 9 }],
  applicability: { paths: ["src/a.ts"], modules: ["web"] },
});
const all = [harvested, ...Array.from({ length: 24 }, (_, index) => record(index + 2))];

type ListCall = { limit: number; offset: number; q?: string; lifecycle?: string };
const calls: ListCall[] = [];
const updates: Array<{ id: string; revision: number; patch: Partial<MemoryDto> }> = [];
let holdGet: Promise<void> | null = null;
memoryApi.list = async (_project, params) => {
  calls.push({ ...params });
  const matched = all.filter((item) => (!params.q || item.title.toLowerCase().includes(params.q.toLowerCase())) && (!params.lifecycle || item.lifecycle === params.lifecycle));
  return { items: matched.slice(params.offset, params.offset + params.limit).map(itemOf), total: matched.length, policy };
};
memoryApi.policy = async () => policy;
memoryApi.get = async (_project, id) => { if (holdGet) await holdGet; return all.find((item) => item.id === id)!; };
memoryApi.update = async (_project, id, revision, patch) => { updates.push({ id, revision, patch }); return { memoryId: id, revision: revision + 1 } as never; };
personalMemoryApi.page = async () => ({ here: [], aboutMe: [], proposals: [], review: [], mode: "auto" });

const settle = (ms = 0) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const confirms: string[] = [];
let confirmAnswer = true;
// Without a host the page asks through the browser's confirm.
Object.defineProperty(dom, "confirm", { configurable: true, writable: true, value: (message: string) => { confirms.push(message); return confirmAnswer; } });

/** The page inside an element that, like the host dialog, closes on Escape. */
async function mount() {
  const dialog = dom.document.createElement("div");
  let dialogEscapes = 0;
  dialog.addEventListener("keydown", (event) => { if ((event as unknown as { key: string }).key === "Escape") dialogEscapes++; });
  dom.document.body.append(dialog);
  const root = createRoot(dialog as unknown as HTMLElement);
  await act(async () => root.render(createElement(MemorySettings, {
    projectId: "p", project: { id: "p", name: "Test project" } as Project, mobile: true, onBack() {}, onClose() {},
  })));
  await settle(10);
  const $ = <T extends Element = HTMLElement>(selector: string) => dialog.querySelector(selector) as unknown as T | null;
  const $$ = <T extends Element = HTMLElement>(selector: string) => [...dialog.querySelectorAll(selector)] as unknown as T[];
  const byText = (selector: string, text: string) => $$(selector).find((element) => element.textContent?.trim() === text);
  return {
    $, $$, byText, escapes: () => dialogEscapes,
    async unmount() { await act(async () => root.unmount()); dialog.remove(); },
  };
}
const setValue = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const proto = element.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
};
const key = async (element: Element, name: string, init: Record<string, unknown> = {}) => {
  await act(async () => { element.dispatchEvent(new dom.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }) as unknown as Event); });
};
const click = async (element: Element | null | undefined) => {
  assert.ok(element != null, "the control is on the page");
  await act(async () => { (element as HTMLElement).click(); });
};

test("a row opens at once, fills in the whole record, and a save keeps what it did not change", async () => {
  calls.length = 0; updates.length = 0;
  const page = await mount();
  assert.equal(page.$$(".memory-row").length, 20, "a first page of twenty rows");
  assert.match(page.$(".memory-summary")?.textContent ?? "", /Records: 25/);

  let release!: () => void;
  holdGet = new Promise((resolve) => { release = resolve; });
  await click(page.$(".memory-row-main"));
  const editor = page.$("[data-memory-editor]");
  assert.ok(editor !== null, "the editor is on screen before the record arrives");
  assert.ok(page.$<HTMLDivElement>(".memory-list-view")!.hidden, "the list waits underneath, hidden");
  const title = page.$<HTMLTextAreaElement>(".memory-title-input")!;
  const body = page.$<HTMLTextAreaElement>(".memory-body-input")!;
  assert.equal(title.value, "Record 1");
  assert.equal(body.value, harvested.body.slice(0, 18), "the row's snippet stands in");
  assert.ok(body.disabled, "nothing can be typed over a record still loading");
  release(); holdGet = null;
  await settle(10);
  assert.equal(body.value, harvested.body, "the whole body replaces the snippet");
  assert.equal(body.disabled, false);
  const save = page.byText("button", "Save")!;
  assert.ok((save as HTMLButtonElement).disabled, "nothing to save yet");

  await setValue(body, `${harvested.body} Checked.`);
  assert.equal((save as HTMLButtonElement).disabled, false);
  assert.ok(page.$(".memory-unsaved") !== null, "an unsaved draft says so");
  await click(save);
  await settle(10);
  assert.equal(updates.length, 1);
  const patch = updates[0]!.patch;
  assert.equal(updates[0]!.revision, 3, "the save names the revision it edited");
  assert.equal(patch.body, `${harvested.body} Checked.`);
  assert.deepEqual(patch.sources, [{ kind: "session", sessionId: "s-1", startSeq: 4, endSeq: 9 }], "a session source stays a session source");
  assert.deepEqual(patch.applicability, { paths: ["src/a.ts"], modules: ["web"] }, "a module stays a module");
  assert.equal(patch.userLocked, true);
  assert.equal(page.$("[data-memory-editor]") === null, true, "back on the list");
  assert.equal(calls.at(-1)?.limit, 20, "the refresh keeps every row that was on screen");
  await page.unmount();
});

test("Escape steps back to the list instead of closing the dialog, and asks before dropping a draft", async () => {
  const page = await mount();
  await click(page.$(".memory-row-main"));
  await settle(10);
  await key(page.$(".memory-title-input")!, "Escape");
  assert.equal(page.$("[data-memory-editor]") === null, true, "a clean record just closes");
  assert.equal(page.escapes(), 0, "the dialog never saw the key");
  assert.equal(confirms.length, 0);

  await click(page.$(".memory-row-main"));
  await settle(10);
  await setValue(page.$<HTMLTextAreaElement>(".memory-title-input")!, "Renamed");
  confirmAnswer = false;
  await key(page.$(".memory-body-input")!, "Escape");
  await settle();
  assert.equal(confirms.length, 1, "a draft is guarded");
  assert.ok(page.$("[data-memory-editor]") !== null, "declined: the draft stays");
  confirmAnswer = true;
  await click(page.byText("button", "Back"));
  await settle();
  assert.equal(page.$("[data-memory-editor]") === null, true);
  assert.equal(page.escapes(), 0);
  confirms.length = 0;

  // Ctrl+Enter saves from any field.
  updates.length = 0;
  await click(page.$(".memory-row-main"));
  await settle(10);
  await setValue(page.$<HTMLTextAreaElement>(".memory-title-input")!, "Renamed by keyboard");
  await key(page.$(".memory-body-input")!, "Enter", { ctrlKey: true });
  await settle(10);
  assert.equal(updates[0]?.patch.title, "Renamed by keyboard");
  await page.unmount();
});

test("search, the lifecycle chips and Show more ask the server for the right rows", async () => {
  calls.length = 0;
  const page = await mount();
  const search = page.$<HTMLInputElement>(".memory-search-input")!;
  await setValue(search, "Record 2");
  await settle(200);
  assert.equal(calls.at(-1)?.q, "Record 2");
  assert.equal(calls.at(-1)?.offset, 0);
  assert.match(page.$(".memory-summary")?.textContent ?? "", /Found: /);
  assert.ok(page.$("mark.memory-mark") !== null, "the match is marked in the row");

  await key(search, "Escape");
  await settle(200);
  assert.equal(search.value, "", "Escape clears the search first");
  assert.equal(page.escapes(), 0, "and the dialog stays open");
  assert.equal(calls.at(-1)?.q, "");

  await click(page.byText('[role="radio"]', "Archived"));
  await settle(200);
  assert.equal(calls.at(-1)?.lifecycle, "archived");
  assert.ok(page.byText(".memory-empty button", "Clear filters") !== undefined, "an empty filter offers the way back");
  await click(page.byText(".memory-empty button", "Clear filters"));
  await settle(200);
  assert.equal(calls.at(-1)?.lifecycle, "");

  assert.equal(page.$$(".memory-row").length, 20);
  await click(page.byText(".memory-more button", "Show more"));
  await settle(10);
  assert.deepEqual({ limit: calls.at(-1)?.limit, offset: calls.at(-1)?.offset }, { limit: 20, offset: 20 });
  assert.equal(page.$$(".memory-row").length, 25, "the next rows join the list");
  assert.equal(page.$(".memory-more") === null, true, "nothing more to load");
  await page.unmount();
});

test("the tags field adds on Enter and commas and gives the last chip back on Backspace", async () => {
  const page = await mount();
  await click(page.byText(".memory-list-view .memory-page-head button", "New memory"));
  const tags = page.$<HTMLInputElement>(".memory-list-input")!;
  await setValue(tags, "alpha, beta");
  const chips = () => page.$$(".memory-list-chip-text").map((chip) => chip.textContent);
  assert.deepEqual(chips(), ["alpha"], "a comma ends a value");
  assert.equal(page.$<HTMLInputElement>(".memory-list-input")!.value, "beta");
  await key(page.$(".memory-list-input")!, "Enter");
  assert.deepEqual(chips(), ["alpha", "beta"]);
  await setValue(page.$<HTMLInputElement>(".memory-list-input")!, "ALPHA");
  await key(page.$(".memory-list-input")!, "Enter");
  assert.deepEqual(chips(), ["alpha", "beta"], "a value is listed once, in any case");
  await setValue(page.$<HTMLInputElement>(".memory-list-input")!, "");
  await key(page.$(".memory-list-input")!, "Backspace");
  assert.deepEqual(chips(), ["alpha"]);
  assert.equal(page.$<HTMLInputElement>(".memory-list-input")!.value, "beta", "taken back for editing");
  await click(page.$('[aria-label="Remove alpha"]'));
  assert.deepEqual(chips(), []);
  await page.unmount();
});

test("deleting one of My notes asks first", async () => {
  const note = { ...itemOf(record(90, { title: "Standup at ten" })), layer: "person" } as MemoryListItem;
  const removed: string[] = [];
  personalMemoryApi.page = async () => ({ here: [note], aboutMe: [], proposals: [], review: [], mode: "auto" });
  personalMemoryApi.remove = async (_project, id) => { removed.push(id); return {} as never; };
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => root.render(createElement(MyNotes, { projectId: "p", project: { id: "p", name: "P", othersHere: true } as Project, translate: (key: string) => key })));
  await settle(10);
  const remove = () => [...host.querySelectorAll(".memory-menu-fallback button")].find((button) => button.textContent === "memory.mine.delete") as unknown as HTMLButtonElement;
  confirms.length = 0;
  confirmAnswer = false;
  await click(remove());
  await settle();
  assert.equal(confirms.length, 1);
  assert.deepEqual(removed, [], "declined: the note stays");
  confirmAnswer = true;
  await click(remove());
  await settle(10);
  assert.deepEqual(removed, [note.id]);
  await act(async () => root.unmount());
  host.remove();
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  await dom.happyDOM.close();
});
