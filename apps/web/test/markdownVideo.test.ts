// Markdown video rendering and document frontmatter: image syntax for video
// files, a bare video URL paragraph, the opt-in properties table, and the URL
// policy shared with images. Mounts MarkdownDoc; the pure helpers are in
// markdown.test.ts.
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
  Element: dom.Element,
  Node: dom.Node,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MarkdownDoc } = await import("../src/markdown/render.tsx");

async function mount(text: string, props: { frontmatter?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(MarkdownDoc, {
      text,
      keyBase: "md-video",
      resourceContext: { projectId: "p1", sessionId: "s1" },
      ...props,
    }));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("a video file behind image syntax renders a player, not a broken image", async () => {
  const view = await mount("![clip](demo.mp4)");
  try {
    const video = view.container.querySelector("video.md-video");
    assert.ok(video, "the video player is rendered");
    assert.equal(video!.getAttribute("src"), "/api/files/raw?projectId=p1&path=demo.mp4&sessionId=s1");
    assert.equal((video as unknown as { controls: boolean }).controls, true, "controls are on");
    assert.match(video!.outerHTML, /\bcontrols\b/, "the controls attribute is present");
    assert.match(video!.outerHTML, /preload="metadata"/);
    assert.equal(view.container.querySelector("img.md-img"), null, "no broken <img> is emitted");
  } finally {
    await view.unmount();
  }
});

test("video detection ignores the query but uses the same URL policy as images", async () => {
  const https = await mount("![clip](https://cdn.example/demo.webm?t=3)");
  try {
    const video = https.container.querySelector("video.md-video");
    assert.equal(video?.getAttribute("src"), "https://cdn.example/demo.webm?t=3");
  } finally {
    await https.unmount();
  }
  // A traversal path is still blocked and shows the shared blocked text.
  const blocked = await mount("![clip](../secret.mp4)");
  try {
    assert.equal(blocked.container.querySelector("video"), null);
    assert.match(blocked.container.querySelector(".md-blocked")?.textContent ?? "", /blocked image source/);
  } finally {
    await blocked.unmount();
  }
});

test("a paragraph that is one bare video URL renders a player plus a caption link", async () => {
  const view = await mount("https://cdn.example/talk.mp4");
  try {
    assert.ok(view.container.querySelector("video.md-video"), "the player is rendered");
    const caption = view.container.querySelector("a.md-video-caption");
    assert.equal(caption?.getAttribute("href"), "https://cdn.example/talk.mp4");
    assert.equal(caption?.textContent, "https://cdn.example/talk.mp4");
  } finally {
    await view.unmount();
  }
});

test("other autolinks and inline video URLs are unchanged", async () => {
  const notVideo = await mount("https://cdn.example/doc.pdf");
  try {
    assert.equal(notVideo.container.querySelector("video"), null, "a non-video autolink stays a link");
    assert.ok(notVideo.container.querySelector("p.md-para a"));
  } finally {
    await notVideo.unmount();
  }
  const inline = await mount("see https://cdn.example/talk.mp4 now");
  try {
    assert.equal(inline.container.querySelector("video"), null, "a video URL inside prose stays a link");
    assert.ok(inline.container.querySelector("a"));
  } finally {
    await inline.unmount();
  }
});

test("frontmatter is off by default and on with the document prop", async () => {
  const doc = "---\ntitle: Release plan\ntags: [a, b]\n---\n# Body\n";
  const off = await mount(doc);
  try {
    assert.equal(off.container.querySelector(".md-frontmatter"), null, "chat rendering is unchanged");
    assert.ok(off.container.querySelector("h1"), "the body still renders");
  } finally {
    await off.unmount();
  }
  const on = await mount(doc, { frontmatter: true });
  try {
    const table = on.container.querySelector("table.md-frontmatter");
    assert.ok(table, "the properties table renders in document mode");
    const rows = table!.querySelectorAll("tbody tr");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.querySelector("th")?.textContent, "title");
    assert.equal(rows[0]!.querySelector("td")?.textContent, "Release plan");
    assert.equal(rows[1]!.querySelector("td")?.textContent, "a, b");
    assert.equal(table!.querySelector("caption")?.textContent, "Properties");
    // The closing fence and a following hr do not leak into the body.
    assert.equal(on.container.querySelectorAll("hr").length, 0);
    assert.ok(on.container.querySelector("h1"));
  } finally {
    await on.unmount();
  }
});

test("document mode with no frontmatter renders the body as usual", async () => {
  const view = await mount("# Just a heading\n\ntext", { frontmatter: true });
  try {
    assert.equal(view.container.querySelector(".md-frontmatter"), null);
    assert.ok(view.container.querySelector("h1"));
  } finally {
    await view.unmount();
  }
});

test("document mode shows a +N more row and marks truncated values", async () => {
  const lines = ["---"];
  lines.push(`big: ${"x".repeat(900)}`);
  for (let i = 0; i < 55; i++) lines.push(`k${i}: v${i}`);
  lines.push("---", "body");
  const view = await mount(lines.join("\n"), { frontmatter: true });
  try {
    const table = view.container.querySelector("table.md-frontmatter");
    assert.ok(table, "the properties table renders");
    const rows = table!.querySelectorAll("tbody tr");
    // 50 capped properties plus the "+N more" row (6 later keys are dropped).
    assert.equal(rows.length, 51);
    const more = table!.querySelector(".md-frontmatter-more");
    assert.ok(more !== null, "the +N more row is present");
    assert.equal(more!.textContent, "+6 more");
    const truncated = rows[0]!.querySelector("td")!.textContent ?? "";
    assert.ok(truncated.endsWith("…"), "a value at the 500-char cap ends in an ellipsis");
    assert.equal(truncated.length, 500);
  } finally {
    await view.unmount();
  }
});
