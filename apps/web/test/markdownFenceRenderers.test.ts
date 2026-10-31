// Package renderers for fenced Markdown blocks (`host.markdown.registerFence`):
// ownership rules, the props the host passes, the failure fallback, and
// activation-scoped disposal.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  getComputedStyle: dom.getComputedStyle.bind(dom),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { MarkdownDoc } = await import("../src/markdown/render.tsx");
const { markdownFenceRenderer, registerMarkdownFence } = await import("../src/markdown/fenceRenderers.ts");
const { createPackageActivation } = await import("../src/packages/activation.ts");
const { webPackageHost } = await import("../src/packages/webHost.ts");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Props = import("@polyth/web-sdk").MarkdownFenceRendererProps;

const seen: Props[] = [];
const Probe = (props: Props) => {
  seen.push(props);
  return createElement("div", { className: "probe", "data-closed": String(props.closed) }, props.text, createElement("div", { className: "probe-source" }, props.source));
};

async function mount(text: string, streaming = false) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(MarkdownDoc, { text, keyBase: "msg-7", streaming, resourceContext: { projectId: "p1", sessionId: "s1" } }));
  });
  return { host, root };
}

test("a registered fence renders through the package with block context and the host source", async () => {
  seen.length = 0;
  const off = registerMarkdownFence({ languages: ["UI"], component: Probe, ownerPackageId: "chat-blocks" });
  try {
    const { host } = await mount("Intro\n\n```ui\ncards X\n- a\n```\n\n```ts\nconst a = 1;\n```");
    assert.equal(host.querySelector(".probe")?.getAttribute("data-closed"), "true");
    const props = seen.at(-1)!;
    assert.equal(props.lang, "ui");
    assert.equal(props.text, "cards X\n- a");
    assert.deepEqual(props.context, { blockKey: "msg-7-b1", projectId: "p1", sessionId: "s1" });
    assert.ok(host.querySelector(".probe-source .md-code-block"), "source is the host's own code frame");
    assert.equal(host.querySelectorAll(".probe").length, 1, "other languages keep the host renderer");
  } finally {
    off();
  }
});

test("extra tokens on the opener reach the package as the first text line", async () => {
  seen.length = 0;
  const off = registerMarkdownFence({ languages: ["ui"], component: Probe, ownerPackageId: "chat-blocks" });
  try {
    const { host } = await mount("```ui steps Release plan\n- done | Spec\n```");
    assert.ok(host.querySelector(".probe"));
    const props = seen.at(-1)!;
    assert.equal(props.lang, "ui");
    assert.equal(props.text, "steps Release plan\n- done | Spec");
    assert.equal(props.info, "steps Release plan", "the opening-line info is passed separately");
    assert.match(host.querySelector(".probe-source")?.textContent ?? "", /steps Release plan/);
    // A language without a renderer keeps the host frame and drops the extra tokens.
    const { host: plain } = await mount("```js steps X\nconst a = 1;\n```");
    assert.equal(plain.querySelector(".md-code-block")?.textContent?.includes("steps X"), false);
  } finally {
    off();
  }
});

test("a fence with no opening-line info still receives info as an empty string", async () => {
  seen.length = 0;
  const off = registerMarkdownFence({ languages: ["ui"], component: Probe, ownerPackageId: "chat-blocks" });
  try {
    await mount("```ui\ncards X\n- a\n```");
    const props = seen.at(-1)!;
    assert.equal(props.info, "");
    assert.equal(props.text, "cards X\n- a");
  } finally {
    off();
  }
});

test("a streaming fence reports closed=false and the renderer updates on unregister", async () => {
  const off = registerMarkdownFence({ languages: ["ui"], component: Probe, ownerPackageId: "chat-blocks" });
  const { host } = await mount("```ui\ncards X\n- a", true);
  assert.equal(host.querySelector(".probe")?.getAttribute("data-closed"), "false");
  await act(async () => { off(); });
  assert.equal(host.querySelector(".probe"), null);
  assert.ok(host.querySelector(".md-code-block"), "disabling the package restores the plain code block");
});

test("built-in fences, malformed names and another owner's language are refused", () => {
  assert.throws(() => registerMarkdownFence({ languages: ["mermaid"], component: Probe, ownerPackageId: "x" }), /rendered by the host/);
  assert.throws(() => registerMarkdownFence({ languages: ["json"], component: Probe, ownerPackageId: "x" }), /rendered by the host/);
  assert.throws(() => registerMarkdownFence({ languages: ["bad lang"], component: Probe, ownerPackageId: "x" }), /invalid fence language/);
  assert.throws(() => registerMarkdownFence({ languages: [], component: Probe, ownerPackageId: "x" }), /at least one/);
  const off = registerMarkdownFence({ languages: ["ui"], component: Probe, ownerPackageId: "chat-blocks" });
  try {
    assert.throws(() => registerMarkdownFence({ languages: ["ui"], component: Probe, ownerPackageId: "intruder" }), /owned by chat-blocks/);
    assert.equal(markdownFenceRenderer("ui"), Probe, "the refused attempt changed nothing");
  } finally {
    off();
  }
  assert.equal(markdownFenceRenderer("ui"), undefined);
});

test("a renderer that throws falls back to the host code block", async () => {
  const original = console.error;
  console.error = () => {};
  const Broken = () => { throw new Error("boom"); };
  const off = registerMarkdownFence({ languages: ["ui"], component: Broken, ownerPackageId: "chat-blocks" });
  try {
    const { host } = await mount("```ui\ncards X\n```");
    const code = host.querySelector(".md-code-block code");
    assert.equal(code?.textContent, "cards X");
  } finally {
    off();
    console.error = original;
  }
});

test("package activation tags the owner and disposes fence registrations", () => {
  const activation = createPackageActivation("chat-blocks", webPackageHost);
  activation.host.markdown!.registerFence({ languages: ["ui"], component: Probe, ownerPackageId: "spoofed" });
  assert.equal(markdownFenceRenderer("ui"), Probe);
  // The scoped host stamps the real owner, so another package cannot claim it.
  assert.throws(() => registerMarkdownFence({ languages: ["ui"], component: Probe, ownerPackageId: "spoofed" }), /owned by chat-blocks/);
  activation.dispose();
  assert.equal(markdownFenceRenderer("ui"), undefined);
  activation.host.markdown!.registerFence({ languages: ["ui"], component: Probe });
  assert.equal(markdownFenceRenderer("ui"), undefined, "registration after disposal is ignored");
});

test("a conversation fence reads the user reply that followed its answer, and only its own", async () => {
  const { ConversationRepliesContext, createConversationReplies, followingReplies } = await import("../src/markdown/conversationReplies.ts");
  const messages = [
    { kind: "user", id: "u1", text: "find hotels" },
    { kind: "assistant", id: "a1", text: "…" },
    { kind: "assistant", id: "a2", text: "…" },
    { kind: "user", id: "u2", text: "shown", raw: "Book: Aurora" },
    { kind: "assistant", id: "a3", text: "…" },
    { kind: "user", id: "u3", text: "rewound", undone: true },
  ];
  assert.deepEqual([...followingReplies(messages)], [["a2", "Book: Aurora"], ["a1", "Book: Aurora"]], "raw text; a rewound prompt is no reply");

  seen.length = 0;
  const off = registerMarkdownFence({ languages: ["ui"], component: Probe, ownerPackageId: "chat-blocks" });
  const store = createConversationReplies();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (conversation: boolean) => act(async () => {
    root.render(createElement(ConversationRepliesContext.Provider, { value: store },
      createElement(MarkdownDoc, { text: "```ui\ncards X\n```", keyBase: "a1", conversation, resourceContext: { projectId: "p1", sessionId: "s1" } })));
  });
  try {
    await render(true);
    assert.equal(seen.at(-1)!.context.reply, undefined, "no reply yet");
    const renders = seen.length;
    // A reply to another answer does not re-render this block.
    store.replace(new Map([["a9", "elsewhere"]]));
    await act(async () => { store.notify(); });
    assert.equal(seen.length, renders);
    store.replace(followingReplies(messages));
    await act(async () => { store.notify(); });
    assert.equal(seen.at(-1)!.context.reply, "Book: Aurora");
    assert.equal(seen.at(-1)!.context.conversation, true);
    await render(false);
    assert.equal(seen.at(-1)!.context.reply, undefined, "outside the conversation there is no reply");
  } finally {
    off();
    await act(async () => { root.unmount(); });
  }
});
