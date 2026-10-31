// Mounted: a block recognises its own reply in history, names items by id,
// validates form values and reports problems with "Ask the agent to fix".
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

let keySeq = 0;
async function mount(text: string, context: { reply?: string; conversation?: boolean; sessionId?: string } = {}) {
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
  const render = async (next: typeof context) => {
    await act(async () => {
      root.render(createElement(ChatBlock, {
        lang: "ui",
        text,
        closed: true,
        source: createElement("pre", { className: "host-source" }, text),
        context: { blockKey: `a${keySeq}-b0`, projectId: "p1", sessionId: next.sessionId ?? "s1", conversation: next.conversation ?? true, ...(next.reply !== undefined ? { reply: next.reply } : {}) },
        host,
      }));
    });
  };
  keySeq += 1;
  await render(context);
  return { container, calls, render };
}
const click = async (element: Element | null | undefined) => {
  assert.ok(element, "element to click exists");
  await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); });
};
const buttonByText = (container: Element, text: string) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);
const typeInto = async (input: Element | null, value: string) => {
  assert.ok(input, "input exists");
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
};
const note = (container: Element) => container.querySelector(".chat-block-actions-note")?.textContent ?? "";

const HOTELS = [
  "cards Hotels · pick=many",
  "- Aurora | old town | $120 | id=h-142",
  "- Cosmos | centre | $80",
  "> Book = Book these: {sel}",
].join("\n");

test("a click names items with their ids", async () => {
  const { container, calls } = await mount(HOTELS);
  await click(container.querySelectorAll(".chat-block-hit")[0]);
  await click(container.querySelectorAll(".chat-block-hit")[1]);
  await click(buttonByText(container, "Book"));
  assert.deepEqual(calls.sent, [["s1", "Book these: Aurora (#h-142), Cosmos"]]);
});

test("a block whose reply is in history shows itself answered, with that selection", async () => {
  const { container, calls } = await mount(HOTELS, { reply: "Book these: Aurora (#h-142)" });
  assert.equal(buttonByText(container, "Book"), undefined, "an answered block cannot send again");
  assert.equal(note(container), "Sent to the agent· Book these: Aurora (#h-142)");
  const hits = [...container.querySelectorAll(".chat-block-hit")];
  assert.deepEqual(hits.map((hit) => hit.getAttribute("aria-checked")), ["true", "false"]);
  assert.equal(hits[1]!.hasAttribute("disabled"), true);
  assert.deepEqual(calls.sent, []);
});

test("an unrelated reply leaves the block open", async () => {
  const { container } = await mount(HOTELS, { reply: "Actually, show me cheaper ones" });
  assert.ok(buttonByText(container, "Book"));
});

test("a reply arriving after mount locks the block (the host re-renders with it)", async () => {
  const { container, render } = await mount(HOTELS);
  assert.ok(buttonByText(container, "Book"));
  await render({ reply: "Book these: Cosmos" });
  assert.equal(buttonByText(container, "Book"), undefined);
  assert.deepEqual([...container.querySelectorAll(".chat-block-hit")].map((hit) => hit.getAttribute("aria-checked")), ["false", "true"]);
});

test("an answered form shows the values it sent", async () => {
  const { container } = await mount("form Trip\n- city | City * | text\n- nights | Nights | number | 2", { reply: "Trip — City: Lviv; Nights: 3" });
  const inputs = [...container.querySelectorAll(".chat-block-field input")] as HTMLInputElement[];
  assert.deepEqual(inputs.map((input) => [input.value, input.disabled]), [["Lviv", true], ["3", true]]);
  assert.equal(buttonByText(container, "Send"), undefined);
});

test("invalid form values block Send and are named", async () => {
  const { container, calls } = await mount("form Contact\n- email | Email * | email\n- age | Age | number | | 18..120");
  const [email, age] = [...container.querySelectorAll(".chat-block-field input")];
  assert.equal(email!.getAttribute("type"), "email");
  assert.deepEqual([age!.getAttribute("min"), age!.getAttribute("max")], ["18", "120"]);
  await typeInto(email!, "me@");
  await typeInto(age!, "12");
  assert.equal(note(container), "Check: Email, Age");
  assert.equal(email!.getAttribute("aria-invalid"), "true");
  assert.equal(buttonByText(container, "Send")?.hasAttribute("disabled"), true);
  await typeInto(email!, "me@example.com");
  await typeInto(age!, "30");
  assert.equal(email!.hasAttribute("aria-invalid"), false);
  await click(buttonByText(container, "Send"));
  assert.deepEqual(calls.sent, [["s1", "Contact — Email: me@example.com; Age: 30"]]);
});

test("problems fold under one line and can be sent back to the agent once", async () => {
  const { container, calls } = await mount("cards Shops · zoom=2\n- A\n- |");
  const panel = container.querySelector(".chat-block-problems");
  assert.ok(panel);
  assert.equal(panel.querySelector("summary")?.textContent, "Problems in this block: 2");
  assert.deepEqual([...panel.querySelectorAll("li code")].map((code) => code.textContent), ["zoom=2", "- |"]);
  await click(buttonByText(container, "Ask the agent to fix"));
  assert.equal(calls.sent.length, 1);
  assert.match(calls.sent[0]![1], /^The ```ui block “Shops” did not render cleanly:\n- line 1: `zoom=2`/);
  assert.equal(buttonByText(container, "Ask the agent to fix"), undefined);
  assert.equal(panel.querySelector(".chat-block-problems-asked")?.textContent, "Asked the agent to fix");
});

test("the fix button is only offered while the conversation has not moved on", async () => {
  const later = await mount("cards Shops · zoom=2\n- A", { reply: "ok" });
  assert.ok(later.container.querySelector(".chat-block-problems"));
  assert.equal(buttonByText(later.container, "Ask the agent to fix"), undefined);
  const elsewhere = await mount("cards Shops · zoom=2\n- A", { conversation: false });
  assert.equal(buttonByText(elsewhere.container, "Ask the agent to fix"), undefined);
});

test("an unknown view keeps the host's code frame and says what views exist", async () => {
  const { container } = await mount("carousel Shots\n- a");
  assert.ok(container.querySelector(".host-source"));
  assert.equal(container.querySelector(".chat-block-problems li code")?.textContent, "carousel");
  assert.match(container.querySelector(".chat-block-problem-hint")?.textContent ?? "", /cards, list, table/);
});
