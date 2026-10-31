// Mounted behaviour of the phase-two views and `from=` data files.
import test, { after, beforeEach } from "node:test";
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
  getComputedStyle: dom.getComputedStyle.bind(dom),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
after(async () => { await dom.happyDOM.close(); });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ChatBlock } = await import("../widgets/ChatBlock.tsx");
const { setRecordsTransportForTests } = await import("../widgets/useBlockRecords.ts");

interface Calls { sent: Array<[string, string]>; inserted: string[] }
const requests: string[] = [];
let files: Record<string, { status: number; body: unknown }> = {};
const fakeFetch = (async (input: string | URL) => {
  const url = String(input);
  requests.push(url);
  const path = new URL(url, "http://x").searchParams.get("path") ?? "";
  const file = files[path] ?? { status: 404, body: { error: "not-found", message: "missing" } };
  return new Response(JSON.stringify(file.body), { status: file.status, headers: { "content-type": "application/json" } });
}) as typeof fetch;
beforeEach(() => {
  requests.length = 0;
  setRecordsTransportForTests(fakeFetch);
});

let keySeq = 0;
async function mount(text: string, options: { sessionId?: string | null; projectId?: string | null } = {}) {
  const calls: Calls = { sent: [], inserted: [] };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const host = {
    ui: { locale: { get: () => "en", translate: (key: string) => key } },
    conversation: {
      send: async (sessionId: string, message: string) => { calls.sent.push([sessionId, message]); return true; },
      insert: (message: string) => { calls.inserted.push(message); },
    },
  } as never;
  const context = {
    blockKey: `v${++keySeq}-b0`,
    ...(options.projectId === null ? {} : { projectId: options.projectId ?? "p1" }),
    ...(options.sessionId === null ? {} : { sessionId: options.sessionId ?? "s1" }),
  };
  await act(async () => {
    root.render(createElement(ChatBlock, { lang: "ui", text, closed: true, source: createElement("pre", { className: "host-source" }, text), context, host }));
  });
  const settle = async () => {
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  await settle();
  return { container, calls, settle, root };
}
const click = async (element: Element | null | undefined) => {
  assert.ok(element, "element to click exists");
  await act(async () => { (element as HTMLElement).click(); });
};
const buttonByText = (container: Element, text: string) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);
const typeInto = async (input: Element | null, value: string) => {
  assert.ok(input, "input exists");
  await act(async () => {
    const proto = input instanceof dom.HTMLTextAreaElement ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
};

test("from= reads the file in the block's session checkout and renders its records", async () => {
  files["_out/deps.json"] = { status: 200, body: { content: JSON.stringify([{ name: "axios", cvss: 9.8 }, { name: "lodash", cvss: 7.4 }]), truncated: false } };
  const { container } = await mount("table Deps · from=_out/deps.json · cols=name:Package,cvss:CVSS · sort=-CVSS", { sessionId: "iso-1" });
  assert.equal(requests.length, 1);
  const query = new URL(requests[0]!, "http://x").searchParams;
  assert.deepEqual([query.get("projectId"), query.get("path"), query.get("sessionId")], ["p1", "_out/deps.json", "iso-1"]);
  assert.deepEqual([...container.querySelectorAll("thead th")].map((th) => th.textContent), ["Package", "CVSS"]);
  assert.deepEqual([...container.querySelectorAll("tbody tr")].map((row) => row.querySelector("td")?.textContent), ["axios", "lodash"]);

  // Refresh re-reads the file.
  files["_out/deps.json"] = { status: 200, body: { content: JSON.stringify([{ name: "ws", cvss: 7.5 }]), truncated: false } };
  const { container: again, settle } = await mount("table Deps · from=_out/deps.json · cols=name:Package,cvss:CVSS", { sessionId: "iso-1" });
  assert.equal(requests.length, 1, "a cached read is reused by a remounted block");
  await click(again.querySelector('button[aria-label="Reload data"]'));
  await settle();
  assert.equal(requests.length, 2);
  assert.deepEqual([...again.querySelectorAll("tbody tr")].map((row) => row.querySelector("td")?.textContent), ["ws"]);
});

test("from= failures explain themselves and keep the source reachable", async () => {
  const missing = await mount("cards Shop · from=_out/none.json");
  assert.match(missing.container.querySelector(".ui-notice")?.textContent ?? missing.container.textContent ?? "", /_out\/none\.json was not found/);
  assert.ok(missing.container.querySelector('button[aria-label="Show as text"]'));

  files["big.json"] = { status: 200, body: { content: "[{\"a\":1}", truncated: true } };
  const big = await mount("table T · from=big.json");
  assert.match(big.container.textContent ?? "", /big\.json is too large/);

  const noProject = await mount("table T · from=x.csv", { projectId: null });
  assert.match(noProject.container.textContent ?? "", /Open a project to read x\.csv/);
  assert.equal(requests.length, 2, "no request without a project");

  files["rows.csv"] = { status: 200, body: { content: "a,b\n1,2\n3,4\n5,\"cut", truncated: true } };
  const cut = await mount("table T · from=rows.csv");
  assert.equal(cut.container.querySelectorAll("tbody tr").length, 2);
  assert.match(cut.container.textContent ?? "", /Showing the first 2 of 2 rows/);
});

test("bar chart scales bars to the largest value and formats numbers with the unit", async () => {
  const { container } = await mount("chart Revenue · unit=₴\n- Month | Online | Shop\n- Jan | 1200 | 300\n- Feb | 600 | 1500");
  const rows = [...container.querySelectorAll(".chat-block-bar-row")];
  assert.equal(rows.length, 2);
  const widths = rows.map((row) => [...row.querySelectorAll(".chat-block-bar")].map((bar) => (bar as HTMLElement).style.inlineSize));
  assert.deepEqual(widths, [["80%", "20%"], ["40%", "100%"]]);
  assert.equal(rows[0]!.querySelector(".chat-block-bar-value")?.textContent, "1,200 ₴ · 300 ₴");
  assert.deepEqual([...container.querySelectorAll(".chat-block-legend li")].map((li) => li.textContent), ["Online", "Shop"]);
});

test("line chart follows the arrow keys with a crosshair and a readable tip", async () => {
  const { container } = await mount("chart Visits · type=line\n- Mon | 3\n- Tue | 7\n- Wed | 5");
  const area = container.querySelector(".chat-block-plot-area") as HTMLElement;
  assert.equal(area.getAttribute("role"), "img");
  assert.equal(area.getAttribute("aria-label"), "Chart of 3 points from Mon to Wed");
  // 0 at the bottom, the top rounded up to a clean axis value (7 → 8).
  assert.equal(container.querySelector(".chat-block-line")?.getAttribute("d"), "M0.0 112.5 L300.0 22.5 L600.0 67.5");
  assert.deepEqual([...container.querySelectorAll(".chat-block-plot-y span")].map((span) => span.textContent), ["8", "0"]);
  await act(async () => { area.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event); });
  await act(async () => { area.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event); });
  assert.equal(container.querySelector(".chat-block-tip strong")?.textContent, "Tue");
  assert.equal((container.querySelector(".chat-block-crosshair") as HTMLElement).style.insetInlineStart, "50%");
  await act(async () => { area.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "End", bubbles: true }) as unknown as Event); });
  assert.equal(container.querySelector(".chat-block-tip strong")?.textContent, "Wed");
});

test("donut folds small slices into Other and reports shares", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => `- s${i} | ${10 - i}`).join("\n");
  const { container } = await mount(`chart Share · type=donut\n${rows}`);
  const legend = [...container.querySelectorAll(".chat-block-donut-legend li")];
  assert.equal(legend.length, 8);
  assert.equal(legend.at(-1)?.querySelector(".chat-block-donut-label")?.textContent, "Other");
  assert.equal(legend[0]?.querySelector(".chat-block-donut-share")?.textContent, "18%");
  assert.equal(container.querySelector(".chat-block-donut-total")?.textContent, "55");
});

test("compare highlights winners and a picked column feeds the button", async () => {
  const { container, calls } = await mount([
    "compare Laptops · pick=one",
    "- | Air 13 | XPS 13",
    "- Price ↓ | $999 | $1,199",
    "- Battery ↑ | 18 h | 12 h",
    "> Choose = I'll take {sel}",
  ].join("\n"));
  assert.deepEqual([...container.querySelectorAll("td.is-best")].map((td) => td.textContent), ["$999↓", "18 h↑"]);
  const heads = [...container.querySelectorAll("button.chat-block-compare-head")];
  assert.equal(heads[1]!.getAttribute("role"), "radio");
  assert.equal(buttonByText(container, "Choose")?.hasAttribute("disabled"), true, "{sel} waits for a pick");
  await click(heads[1]);
  assert.equal(container.querySelectorAll("td.is-selected").length, 2, "the picked column is tinted");
  await click(buttonByText(container, "Choose"));
  assert.deepEqual(calls.sent, [["s1", "I'll take XPS 13"]]);
});

test("form sends one line once required fields are filled", async () => {
  const { container, calls } = await mount([
    "form Trip",
    "- city | City * | text",
    "- nights | Nights | number | 2",
    "- breakfast | Breakfast | toggle | true",
    "- notes | Notes | textarea",
  ].join("\n"));
  const send = () => buttonByText(container, "Send");
  assert.equal(send()?.hasAttribute("disabled"), true);
  assert.equal(container.querySelector(".chat-block-actions-note")?.textContent, "Fill in: City");
  const inputs = [...container.querySelectorAll(".chat-block-field input, .chat-block-field textarea")];
  await typeInto(inputs.find((input) => input.getAttribute("type") === "text") ?? null, "Lviv");
  await typeInto(container.querySelector(".chat-block-field textarea"), "quiet room");
  await click(container.querySelector('[role="switch"]'));
  assert.equal(send()?.hasAttribute("disabled"), false);
  await click(send());
  await act(async () => { await Promise.resolve(); });
  assert.deepEqual(calls.sent, [["s1", "Trip — City: Lviv; Nights: 2; Breakfast: no; Notes: quiet room"]]);
  assert.equal((container.querySelector(".chat-block-field input") as HTMLInputElement).disabled, true, "a sent form locks");
});

test("steps show status by mark and by text, with progress in the head", async () => {
  const { container } = await mount("steps Release\n- done | Build\n- doing | Deploy | canary 10%\n- fail | Smoke\n- todo | Announce");
  assert.equal(container.querySelector(".chat-block-count")?.textContent, "1/4");
  assert.deepEqual([...container.querySelectorAll(".chat-block-step")].map((li) => li.className), [
    "chat-block-step is-done", "chat-block-step is-doing", "chat-block-step is-fail", "chat-block-step is-todo",
  ]);
  assert.deepEqual([...container.querySelectorAll(".chat-block-step-state")].map((span) => span.textContent), ["Done", "In progress", "Failed", "To do"]);
  // Self-evident states are spoken, not printed on every row.
  assert.deepEqual([...container.querySelectorAll(".chat-block-step-state:not(.sr-only)")].map((span) => span.textContent), ["In progress", "Failed"]);
  assert.equal(container.querySelector('[aria-current="step"] .chat-block-step-title')?.textContent, "Deploy");
});

test("an unstarted plan is read-only: numbered markers, a plain count, no controls", async () => {
  const { container } = await mount("steps Next\n- todo | Appeal the flag | https://safebrowsing.google.com/safebrowsing/report_error/ (review takes 1–3 days).\n- todo | Drop the wildcard | keep the `rewrite` only");
  assert.equal(container.querySelector(".chat-block-count")?.textContent, "2", "not a 0/2 checklist");
  assert.deepEqual([...container.querySelectorAll(".chat-block-step-mark")].map((mark) => mark.textContent), ["1", "2"]);
  assert.equal(container.querySelector(".chat-block-steps")?.querySelectorAll("button, input, [role=checkbox], [role=radio]").length, 0);
  const link = container.querySelector(".chat-block-step-detail a") as HTMLAnchorElement;
  assert.equal(link.getAttribute("href"), "https://safebrowsing.google.com/safebrowsing/report_error/");
  assert.equal(link.textContent, "safebrowsing.google.com/safebrowsing/report_error");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(container.querySelector(".chat-block-step-detail")?.textContent, "safebrowsing.google.com/safebrowsing/report_error (review takes 1–3 days).");
  assert.equal(container.querySelectorAll(".chat-block-step")[1]?.querySelector(".chat-block-step-detail code")?.textContent, "rewrite");
});

test("inline text links only http(s) URLs and keeps trailing punctuation as text", async () => {
  const { container } = await mount("table T\n- A\n- see https://example.com/a?b=1, or javascript:alert(1) and `https://not.linked`");
  const cell = container.querySelector(".chat-block-table td")!;
  assert.deepEqual([...cell.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["https://example.com/a?b=1"]);
  assert.equal(cell.querySelector("code")?.textContent, "https://not.linked");
  assert.equal(cell.textContent, "see example.com/a?b=1, or javascript:alert(1) and https://not.linked");
});

test("gallery opens the shared viewer at the clicked image; project images use the session checkout", async () => {
  const { container } = await mount("media Screens\n- shots/a.png | Home\n- https://img.example/b.png | Settings\n- javascript:x.png | Bad", { sessionId: "iso-9" });
  const images = [...container.querySelectorAll(".chat-block-tile img")].map((img) => img.getAttribute("src"));
  assert.deepEqual(images, [
    "/api/files/raw?projectId=p1&path=shots%2Fa.png&sessionId=iso-9",
    "https://img.example/b.png",
  ]);
  assert.equal(container.querySelectorAll(".chat-block-tile").length, 2, "a non-image row is not a tile");
  await click(container.querySelectorAll(".chat-block-tile .chat-block-hit")[1]);
  const viewer = document.body.querySelector('[role="dialog"]');
  assert.ok(viewer, "the shared viewer opens");
  assert.match(viewer?.textContent ?? "", /2 \/ 2|2 of 2|Settings/);
});
