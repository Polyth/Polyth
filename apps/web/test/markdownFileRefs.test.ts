// File references inside rendered markdown: which tokens become editor links
// and which stay code. The grammar itself is covered by markdown.test.ts; this
// mounts the real renderer because the failure was in the inline rendering
// path (a linkified code span loses its `<code>` wrapper, and a markdown link
// wraps its own text in a second, nested interactive control).
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
const { applyProjectUpsert } = await import("../src/store.ts");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

// The project's checkout, so absolute link paths can be mapped into it.
applyProjectUpsert({ id: "refs-project", path: "/home/polyth/workspace/Business1", name: "Business1", createdAt: 0 } as never);

// File references resolve against a project resource context; without one the
// renderer deliberately leaves paths as code.
async function html(text: string, documentPath?: string): Promise<string> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(MarkdownDoc, { text, keyBase: "refs", resourceContext: { projectId: "refs-project", sessionId: null }, ...(documentPath ? { documentPath } : {}) }));
    });
    return host.innerHTML;
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
}

test("a code span that is not a path keeps its code chip", async () => {
  const out = await html("Тести: `35/35` viewport");
  assert.match(out, /<code>35\/35<\/code>/);
  assert.doesNotMatch(out, /file-ref/);
});

test("CSS value pairs inside a code span stay one code chip", async () => {
  const out = await html("`html static/visible` замість `fixed/hidden`");
  assert.match(out, /<code>html static\/visible<\/code>/);
  assert.match(out, /<code>fixed\/hidden<\/code>/);
  assert.doesNotMatch(out, /file-ref/);
});

test("a real path in a code span still opens the editor", async () => {
  const out = await html("`apps/web/src/mobileViewport.ts`");
  assert.match(out, /class="resource-link file-ref"/);
  assert.doesNotMatch(out, /<code>apps\/web\/src\/mobileViewport\.ts<\/code>/);
});

test("a markdown link to a path is one file control, never a button nested in an anchor", async () => {
  const out = await html("[mobileViewport.ts](/apps/web/src/mobileViewport.ts)");
  assert.match(out, /<button [^>]*class="resource-link file-ref md-file-link"[^>]*>mobileViewport\.ts<\/button>/);
  assert.match(out, /title="apps\/web\/src\/mobileViewport\.ts\s/);
  assert.doesNotMatch(out, /<a /);
});

test("a markdown link to an absolute workspace path opens in Project files, not the browser", async () => {
  const out = await html("Я вивчив базу. [Покажчик проєкту](/home/polyth/workspace/Business1/INDEX.md) і [Статут CEO](/home/polyth/workspace/Business1/departments/ceo/AGENTS.md).");
  assert.match(out, /<button [^>]*class="resource-link file-ref md-file-link"[^>]*>Покажчик проєкту<\/button>/);
  assert.match(out, /title="INDEX\.md\s/);
  assert.match(out, /title="departments\/ceo\/AGENTS\.md\s/);
  assert.doesNotMatch(out, /href="\/home\//);
  assert.doesNotMatch(out, /<a /);
});

test("relative and file:// links open in Project files; web links stay links", async () => {
  const out = await html("[agents](departments/ceo/AGENTS.md) [page](file:///home/polyth/workspace/Business1/site/index.html) [web](https://example.com/a.md)");
  assert.match(out, /title="departments\/ceo\/AGENTS\.md\s/);
  assert.match(out, /title="site\/index\.html\s/);
  assert.match(out, /<a class="md-link" href="https:\/\/example\.com\/a\.md" target="_blank" rel="noopener noreferrer">web<\/a>/);
});

test("a link that climbs out of the workspace is plain text, not a broken link", async () => {
  const out = await html("[secret](../../etc/passwd)");
  assert.match(out, /<span title="\.\.\/\.\.\/etc\/passwd">secret<\/span>/);
  assert.doesNotMatch(out, /<a |file-ref/);
});

test("a previewed document's relative links resolve from its own directory", async () => {
  const out = await html("[guide](guide.md) [readme](../README.md)", "docs/dev/index.md");
  assert.match(out, /title="docs\/dev\/guide\.md\s/);
  assert.match(out, /title="docs\/README\.md\s/);
});
