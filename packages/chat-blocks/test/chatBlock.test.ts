// Mounted behaviour of the ```ui fence renderer: selection, the one message a
// click sends, local sort/filter, the text fallback and the URL policy.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);
const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  localStorage: dom.localStorage,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
after(async () => { await dom.happyDOM.close(); });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ChatBlock } = await import("../widgets/ChatBlock.tsx");

interface Calls { sent: Array<[string, string]>; inserted: string[] }

function makeHost(calls: Calls, sendResult: boolean | "throw" = true) {
  return {
    ui: { locale: { get: () => "en", translate: (key: string) => key } },
    conversation: {
      send: async (sessionId: string, text: string) => {
        if (sendResult === "throw") throw new Error("offline");
        calls.sent.push([sessionId, text]);
        return sendResult;
      },
      insert: (text: string) => { calls.inserted.push(text); },
    },
  } as never;
}

let keySeq = 0;
async function mount(text: string, options: { closed?: boolean; sessionId?: string | null; sendResult?: boolean | "throw" } = {}) {
  const calls: Calls = { sent: [], inserted: [] };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const source = createElement("pre", { className: "host-source" }, text);
  await act(async () => {
    root.render(createElement(ChatBlock, {
      lang: "ui",
      text,
      closed: options.closed ?? true,
      source,
      context: { blockKey: `m${++keySeq}-b0`, projectId: "p1", ...(options.sessionId === null ? {} : { sessionId: options.sessionId ?? "s1" }) },
      host: makeHost(calls, options.sendResult),
    }));
  });
  const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
  return { container, calls, root, flush };
}

const click = async (element: Element | null | undefined) => {
  assert.ok(element, "element to click exists");
  await act(async () => { (element as HTMLElement).click(); });
};
const buttonByText = (container: Element, text: string) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);

const CARDS = [
  "cards Headphones · pick=many",
  "- https://cdn.example/a.jpg | Sony XM6 | ANC | $399 | ★4.8 | https://shop.example/a",
  "- [x] https://cdn.example/b.jpg | Bose QC | comfort | $379",
  "- javascript:alert(1) | Evil | x | $1 | | javascript:alert(2)",
  "> Compare selected = Compare in detail: {sel}",
].join("\n");

test("cards toggle selection and send one compact message to the block's session", async () => {
  const { container, calls, flush } = await mount(CARDS);
  const hits = [...container.querySelectorAll(".chat-block-card .chat-block-hit")];
  assert.equal(hits.length, 3);
  assert.equal(hits[1]!.getAttribute("aria-checked"), "true", "[x] preselects");
  assert.equal(container.querySelector(".chat-block-actions-note")?.textContent, "1 selected");
  await click(hits[0]);
  assert.equal(hits[0]!.getAttribute("aria-checked"), "true");
  assert.equal(container.querySelector(".chat-block-actions-note")?.textContent, "2 selected");

  await click(buttonByText(container, "Compare selected"));
  await flush();
  assert.deepEqual(calls.sent, [["s1", "Compare in detail: Sony XM6, Bose QC"]]);
  assert.deepEqual(calls.inserted, []);
  assert.equal(container.querySelector(".chat-block-actions-note")?.textContent, "Sent to the agent· Compare in detail: Sony XM6, Bose QC");
  assert.equal(buttonByText(container, "Compare selected"), undefined, "a sent block cannot send twice");
  assert.equal(hits[2]!.hasAttribute("disabled"), true, "selection locks after sending");
});

test("a second click while the send is in flight does not send twice", async () => {
  const calls: Calls = { sent: [], inserted: [] };
  let release!: (value: boolean) => void;
  const host = {
    ui: { locale: { get: () => "en", translate: (key: string) => key } },
    conversation: {
      send: (sessionId: string, text: string) => { calls.sent.push([sessionId, text]); return new Promise<boolean>((resolve) => { release = resolve; }); },
      insert: (text: string) => { calls.inserted.push(text); },
    },
  } as never;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ChatBlock, { lang: "ui", text: "list L\n- A\n> Go", closed: true, source: null, context: { blockKey: "race-b0", sessionId: "s1" }, host }));
  });
  const go = buttonByText(container, "Go");
  await click(go);
  await click(go);
  assert.equal(go?.hasAttribute("disabled"), true);
  await act(async () => { release(true); await Promise.resolve(); });
  assert.deepEqual(calls.sent, [["s1", "Go"]]);
  assert.match(container.querySelector(".chat-block-actions-note")?.textContent ?? "", /^Sent to the agent/);
});

test("unsafe image and link URLs never reach the DOM", async () => {
  const { container } = await mount(CARDS);
  // A non-URL first field is just text (the title); no attribute may carry it.
  const attributes = [...container.querySelectorAll("[href], [src], [srcset]")]
    .flatMap((el) => ["href", "src", "srcset"].map((name) => el.getAttribute(name) ?? ""));
  assert.equal(attributes.some((value) => /javascript:/i.test(value)), false);
  assert.equal(container.querySelectorAll(".chat-block-card-title")[2]?.textContent, "javascript:alert(1)");
  const images = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
  assert.deepEqual(images, ["https://cdn.example/a.jpg", "https://cdn.example/b.jpg"]);
  const open = container.querySelector(".chat-block-open");
  assert.equal(open?.getAttribute("href"), "https://shop.example/a");
  assert.equal(open?.getAttribute("rel"), "noopener noreferrer");
  // The evil card still renders its text with a monogram instead of an image.
  assert.equal(container.querySelectorAll(".chat-block-monogram").length, 3);
});

test("without a session, or when the send is refused, the message becomes an editable draft", async () => {
  const noSession = await mount("list Pick · pick=one\n- A\n- B\n> Use it", { sessionId: null });
  await click(noSession.container.querySelectorAll(".chat-block-hit")[1]);
  await click(buttonByText(noSession.container, "Use it"));
  await noSession.flush();
  assert.deepEqual(noSession.calls.inserted, ["Use it: B"]);
  assert.deepEqual(noSession.calls.sent, []);

  const refused = await mount("list Pick\n- A\n> Retry", { sendResult: false });
  await click(buttonByText(refused.container, "Retry"));
  await refused.flush();
  assert.deepEqual(refused.calls.inserted, ["Retry"]);
  assert.ok(buttonByText(refused.container, "Retry"), "a refused send keeps its button");

  const failed = await mount("list Pick\n- A\n> Retry", { sendResult: "throw" });
  await click(buttonByText(failed.container, "Retry"));
  await failed.flush();
  assert.deepEqual(failed.calls.inserted, ["Retry"]);

  const draft = await mount("list Pick · send=draft\n- A\n> Go");
  await click(buttonByText(draft.container, "Go"));
  await draft.flush();
  assert.deepEqual(draft.calls.inserted, ["Go"]);
  assert.deepEqual(draft.calls.sent, []);
});

test("a choice sends the question with the picked answer; Send waits for a pick", async () => {
  const { container, calls, flush } = await mount("choice How do we update?\n- Critical only | lowest risk\n- Everything | run tests");
  const group = container.querySelector(".chat-block-choices");
  assert.equal(group?.getAttribute("role"), "radiogroup");
  const send = buttonByText(container, "Send");
  assert.equal(send?.hasAttribute("disabled"), true);
  const options = [...container.querySelectorAll(".chat-block-choice")];
  await click(options[0]);
  await click(options[1]);
  assert.deepEqual(options.map((option) => option.getAttribute("aria-checked")), ["false", "true"], "single choice keeps one");
  await click(buttonByText(container, "Send"));
  await flush();
  assert.deepEqual(calls.sent, [["s1", "How do we update? — Everything"]]);
});

test("table sorts numerically, filters locally and folds long results", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => `- pkg${i} | ${(i * 7) % 12}.0 | \`v${i}\``);
  const { container } = await mount(["table Deps", "- name | score | tag", ...rows].join("\n"));
  const firstCells = () => [...container.querySelectorAll("tbody tr")].map((row) => row.querySelector("td")?.textContent);
  assert.equal(container.querySelectorAll("tbody tr").length, 10, "folded to ten rows");
  assert.equal(container.querySelector("td code")?.textContent, "v0", "backticks become code");
  const scoreHeader = container.querySelectorAll("th")[1]!;
  assert.equal(scoreHeader.className, "is-num");
  await click(scoreHeader.querySelector("button"));
  assert.equal(scoreHeader.getAttribute("aria-sort"), "descending", "numbers sort high-first");
  assert.equal(firstCells()[0], "pkg5");
  await click(buttonByText(container, "Show all 12"));
  assert.equal(container.querySelectorAll("tbody tr").length, 12);

  const filter = container.querySelector("input.chat-block-search") as HTMLInputElement | null;
  assert.ok(filter, "a filter appears for longer tables");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
    setter.call(filter, "pkg1");
    filter!.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  assert.deepEqual(firstCells().sort(), ["pkg1", "pkg10", "pkg11"]);
  assert.equal(container.querySelector(".chat-block-count")?.textContent, "3 of 12");
});

test("a Markdown-style table without row bullets still renders its rows", async () => {
  // The shape a model writes when it copies a Markdown table into a ui fence:
  // no `- ` markers, wrapping bars and a separator rule.
  const { container } = await mount([
    "table Channels",
    "| Variant | Speed | Cost |",
    "| --- | --- | --- |",
    "| Balance | one stream | medium |",
    "| MPTCP | aggregated | high |",
  ].join("\n"));
  assert.deepEqual([...container.querySelectorAll("thead th")].map((th) => th.textContent), ["Variant", "Speed", "Cost"]);
  assert.deepEqual([...container.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((td) => td.textContent)), [
    ["Balance", "one stream", "medium"],
    ["MPTCP", "aggregated", "high"],
  ]);
  assert.equal(container.querySelector(".chat-block-empty"), null, "no empty-state over real rows");
  assert.equal(container.querySelector(".chat-block-notes"), null, "rows are not captions");
});

test("an unparseable caption keeps its own line instead of one long paragraph", async () => {
  const { container } = await mount("list L\nFirst caption\nSecond caption\n- A");
  const notes = container.querySelector(".chat-block-notes");
  assert.equal(notes?.textContent, "First caption\nSecond caption");
});

test("an overflowing table pans with a mouse drag and keeps sort clicks intact", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => `- pkg${i} | ${i} | tag`);
  const { container } = await mount(["table Deps", "- name | score | tag", ...rows].join("\n"));
  const wrap = container.querySelector(".chat-block-table-wrap") as HTMLElement;
  assert.equal(wrap.tabIndex, 0, "the scroll region is keyboard reachable");
  assert.equal(wrap.getAttribute("aria-label"), "Deps");
  Object.defineProperty(wrap, "clientWidth", { value: 240, configurable: true });
  Object.defineProperty(wrap, "scrollWidth", { value: 720, configurable: true });
  wrap.scrollLeft = 200;
  const pointer = (type: string, clientX: number, pointerType = "mouse") =>
    new dom.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 4, pointerType, button: 0, clientX }) as unknown as Event;

  // Pulling left moves the content left: scrollLeft grows by the drag distance.
  await act(async () => {
    wrap.dispatchEvent(pointer("pointerdown", 300));
    wrap.dispatchEvent(pointer("pointermove", 250));
  });
  assert.equal(wrap.scrollLeft, 250);
  assert.ok(wrap.classList.contains("is-dragging"), "the grab cursor state is on");
  await act(async () => { wrap.dispatchEvent(pointer("pointerup", 250)); });
  assert.equal(wrap.classList.contains("is-dragging"), false);

  // A drag that starts on a header does not also sort it.
  const sortButton = wrap.querySelector("th button")!;
  const header = sortButton.closest("th")!;
  await act(async () => {
    sortButton.dispatchEvent(pointer("pointerdown", 300));
    sortButton.dispatchEvent(pointer("pointermove", 240));
    sortButton.dispatchEvent(pointer("pointerup", 240));
    sortButton.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  assert.equal(header.getAttribute("aria-sort"), "none", "the pan swallowed the sort click");

  // Touch is left to the browser's native inertial scrolling.
  wrap.scrollLeft = 0;
  await act(async () => {
    wrap.dispatchEvent(pointer("pointerdown", 300, "touch"));
    wrap.dispatchEvent(pointer("pointermove", 200, "touch"));
    wrap.dispatchEvent(pointer("pointerup", 200, "touch"));
  });
  assert.equal(wrap.scrollLeft, 0);

  // A table that fits never starts a pan.
  Object.defineProperty(wrap, "scrollWidth", { value: 240, configurable: true });
  wrap.scrollLeft = 0;
  await act(async () => {
    wrap.dispatchEvent(pointer("pointerdown", 300));
    wrap.dispatchEvent(pointer("pointermove", 200));
    wrap.dispatchEvent(pointer("pointerup", 200));
  });
  assert.equal(wrap.scrollLeft, 0);
});

test("stats show direction and a sparkline", async () => {
  const { container } = await mount("stats Week\n- Revenue | 412k | +12% | 3,4,6\n- Returns | 2.1% | −0.6 pp | 2,3,4\n- Flat | 1 | 0%");
  const deltas = [...container.querySelectorAll(".chat-block-delta")];
  assert.deepEqual(deltas.map((delta) => delta.className), ["chat-block-delta is-up", "chat-block-delta is-down", "chat-block-delta is-flat"]);
  assert.deepEqual(deltas.map((delta) => delta.textContent), ["12%", "0.6 pp", "0%"]);
  assert.equal(container.querySelectorAll(".chat-block-spark").length, 2);
});

test("a list row keeps a short value at its end and moves running text into the body", async () => {
  const { container } = await mount([
    "list Left · pick=many",
    "- /tmp/claude-1001 | 145M | working caches of live CLIs (deleting means a recompile, not a crash)",
    "- ~/.codex/packages | 773M | 14 999 ₴ | current",
    "> Clean = Clean {sel}",
  ].join("\n"));
  const [long, short] = [...container.querySelectorAll(".chat-block-row")];
  assert.equal(long!.querySelector(".chat-block-row-end"), null, "no end column for running text");
  assert.match(long!.querySelector(".chat-block-row-main .chat-block-row-note")?.textContent ?? "", /^working caches/);
  assert.equal(short!.querySelector(".chat-block-row-end .chat-block-value")?.textContent, "14 999 ₴");
  assert.equal(short!.querySelector(".chat-block-row-note"), null);
  // The mark is its own last cell, so every row's mark lines up at one edge.
  for (const row of [long!, short!]) {
    const cells = [...row.children].map((child) => child.className.split(" ")[0]);
    assert.deepEqual(cells.filter((name) => name !== "chat-block-hit").slice(-1), ["chat-block-mark"]);
  }
  // Buttons are one group, so a wrap keeps them together at the end.
  assert.equal(container.querySelectorAll(".chat-block-actions > .chat-block-actions-buttons > button").length, 1);
});

test("show-as-text swaps to the host source and back; copy exports Markdown", async () => {
  const { container } = await mount("list Shops\n- Rozetka | tomorrow | 14 999");
  await click(container.querySelector('button[aria-label="Show as text"]'));
  assert.ok(container.querySelector(".host-source"));
  assert.equal(container.querySelector(".chat-block-list"), null);
  await click(container.querySelector('button[aria-label="Show as block"]'));
  assert.equal(container.querySelector(".host-source"), null);
  assert.ok(container.querySelector(".chat-block-list"));
});

test("streaming shows a placeholder; a closed unknown block falls back to the source", async () => {
  const pending = await mount("car", { closed: false });
  assert.equal(pending.container.querySelector(".chat-block")?.getAttribute("aria-busy"), "true");
  const growing = await mount("cards Items\n- A | first\n- B | sec", { closed: false });
  assert.equal(growing.container.querySelectorAll(".chat-block-card:not(.chat-block-pending)").length, 1);
  assert.equal(growing.container.querySelectorAll(".chat-block-pending").length, 1);
  assert.equal(growing.container.querySelector(".chat-block-actions"), null, "no actions until the block is complete");
  const unknown = await mount("kanban Board\n- a");
  assert.ok(unknown.container.querySelector(".host-source"));
  assert.equal(unknown.container.querySelector(".chat-block"), null);
});
