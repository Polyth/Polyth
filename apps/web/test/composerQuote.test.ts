// "Quote in reply" in the composer: the quote joins the draft as its own
// Markdown block, the field draws quote lines like the transcript's
// `.md-quote` through a text layer (the draft text itself never changes), and
// the field's own glyphs only go transparent while the draft holds a quote.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  HTMLTextAreaElement: (dom as unknown as { HTMLTextAreaElement: typeof HTMLTextAreaElement }).HTMLTextAreaElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: (dom as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement, createRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const AdaptiveTextInput = (await import("../src/components/input/AdaptiveTextInput.tsx")).default;
type TextInputHandle = import("../src/components/input/AdaptiveTextInput.tsx").TextInputHandle;
const { hasQuote, mirrorLines, QUOTE_MIRROR_ATTR } = await import("../src/components/input/quoteMirror.ts");
const { COMPOSER_QUOTE, drainInserts, joinComposerInsert, requestComposerQuote } = await import("../src/composerInsert.ts");
const { quoteForReply } = await import("../src/selectionActions.ts");
const { parseMarkdown, quoteLineMask } = await import("../src/markdown/parse.ts");
const EventCtor = (dom as unknown as { Event: typeof Event }).Event;

test("a quote joins the draft as its own block; other inserts still join with a space", () => {
  const q = quoteForReply("picked words");
  assert.equal(q, "> picked words\n\n");
  assert.equal(joinComposerInsert("", q), q);
  assert.equal(joinComposerInsert("my note", q), "my note\n\n> picked words\n\n");
  assert.equal(joinComposerInsert("my note  ", q), "my note\n\n> picked words\n\n", "trailing spaces do not stay before the break");
  assert.equal(joinComposerInsert("> earlier\n\n", q), "> earlier\n\n> picked words\n\n", "two quotes stay two blocks");
  assert.equal(joinComposerInsert("> earlier\n", q), "> earlier\n\n> picked words\n\n");
  assert.equal(joinComposerInsert("Explain", "@src/a.ts"), "Explain @src/a.ts");
});

test("the reply under a quote is not part of it", () => {
  const blocks = parseMarkdown(`${quoteForReply("one\ntwo")}my reply`);
  assert.deepEqual(blocks.map((b) => b.kind), ["quote", "para"]);
});

test("the composer marks exactly the lines the transcript renders as a quote", () => {
  const draft = "> real quote\n```sh\n> not a quote\n```\n$$\n> x\n$$\nplain > inline\n  > indented quote";
  assert.deepEqual(quoteLineMask(draft), [true, false, false, false, false, false, false, false, true]);
  const rendered = parseMarkdown(draft).map((b) => b.kind);
  assert.deepEqual(rendered, ["quote", "code", "mathBlock", "para", "quote"]);
  assert.equal(hasQuote("```\n> only code\n```"), false, "a quote-free draft keeps its own glyphs");
});

test("mirror lines mark quote runs and keep the > marks as aligned text", () => {
  assert.equal(hasQuote("plain\ntext"), false);
  assert.equal(hasQuote("a\n  > b"), true);
  const lines = mirrorLines("> one\n>\n> two\nreply\n> solo");
  assert.deepEqual(lines.map((l) => [l.marker, l.text, l.edge ?? "", l.reach ?? ""]), [
    ["> ", "one", "first", "start"],
    [">", "", "middle", ""],
    ["> ", "two", "last", ""],
    ["", "reply", "", ""],
    ["> ", "solo", "only", "end"],
  ]);
  // A blank line beside a quote is where the band takes its padding and gap.
  assert.deepEqual(mirrorLines("note\n\n> q\n\nreply").map((l) => l.reach ?? ""), ["", "", "both", "", ""]);
  assert.deepEqual(mirrorLines(">> nested").map((l) => l.marker), [">> "]);
});

async function mount(quoteMirror: boolean) {
  const handle = createRef<TextInputHandle>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(AdaptiveTextInput, { ref: handle, quoteMirror }));
  });
  const ta = container.querySelector("textarea")!;
  const layer = () => container.querySelector<HTMLElement>(".quote-mirror");
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  };
  return { handle, ta, layer, unmount };
}

test("the field draws its quotes through the layer only while it holds one", async () => {
  const { handle, ta, layer, unmount } = await mount(true);
  try {
    assert.ok(layer(), "layer mounted beside the field");
    assert.equal(layer()!.hidden, true);
    assert.equal(ta.hasAttribute(QUOTE_MIRROR_ATTR), false, "plain drafts keep their own glyphs");

    await act(async () => { handle.current!.replaceText("> quoted\nreply"); });
    assert.equal(ta.value, "> quoted\nreply", "the draft text is untouched");
    assert.equal(ta.hasAttribute(QUOTE_MIRROR_ATTR), true);
    assert.equal(layer()!.hidden, false);
    const rows = [...layer()!.querySelectorAll(".quote-mirror-line")];
    assert.equal(rows.length, 2);
    assert.ok(rows[0]!.classList.contains("quote-mirror-quote"));
    assert.equal(rows[0]!.querySelector(".quote-mirror-mark")?.textContent, "> ");
    assert.equal(rows[1]!.textContent, "reply");

    // Typing follows the layer (user input, not only programmatic edits).
    ta.value = "> quoted\nreply and more";
    ta.dispatchEvent(new EventCtor("input", { bubbles: true }));
    assert.equal(layer()!.querySelectorAll(".quote-mirror-line")[1]!.textContent, "reply and more");

    // Deleting the quote hands the glyphs back to the field.
    ta.value = "reply and more";
    ta.dispatchEvent(new EventCtor("input", { bubbles: true }));
    assert.equal(ta.hasAttribute(QUOTE_MIRROR_ATTR), false);
    assert.equal(layer()!.hidden, true);
    assert.equal(layer()!.childElementCount, 0);
  } finally {
    await unmount();
  }
});

test("without the option the field renders alone", async () => {
  const { handle, ta, layer, unmount } = await mount(false);
  try {
    await act(async () => { handle.current!.replaceText("> quoted\n"); });
    assert.equal(layer(), null);
    assert.equal(ta.hasAttribute(QUOTE_MIRROR_ATTR), false);
  } finally {
    await unmount();
  }
});

test("a quote with no composer mounted queues for the next one", () => {
  drainInserts();
  const seen: string[] = [];
  const listen = (e: Event) => { seen.push(String((e as CustomEvent).detail)); };
  window.addEventListener(COMPOSER_QUOTE, listen);
  try {
    assert.equal(requestComposerQuote("> q\n"), false, "nobody consumed it");
    assert.deepEqual(seen, ["> q\n"]);
    assert.deepEqual(drainInserts(), ["> q\n"]);
    assert.equal(requestComposerQuote(""), false);
    assert.deepEqual(drainInserts(), [], "an empty quote is not queued");
  } finally {
    window.removeEventListener(COMPOSER_QUOTE, listen);
  }
});
