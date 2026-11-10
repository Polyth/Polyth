import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);

const { createElement, Fragment } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { parseMarkdown } = await import("../src/markdown/parse.ts");
const { renderBlocks } = await import("../src/markdown/render.tsx");
const HostingBody = (await import("../../../packages/code-hosting/widgets/HostingBody.tsx")).default;

/** The host's real `MarkdownDoc` pulls in app stores; the body view only passes
 *  text to it, so the parser plus block renderer is the same path. */
const MarkdownDoc = ({ text, keyBase = "md" }: { text: string; keyBase?: string }) =>
  createElement(Fragment, null, ...renderBlocks(parseMarkdown(text), keyBase));
const host = { ui: { components: { MarkdownDoc } } };

const DEPENDABOT = [
  "Bump actions/checkout from 4.4.0 to 7.0.1",
  "",
  "<details>",
  "<summary>Release notes</summary>",
  '<p><em>Sourced from <a href="https://github.com/actions/checkout/releases">the releases page</a>.</em></p>',
  "<h2>v7.0.1</h2>",
  "<ul><li>skip the unsafe check by <a href=\"https://github.com/aiqiaoy\"><code>@aiqiaoy</code></a> in <a href=\"https://example.com/pull/2518\">#2518</a></li></ul>",
  "</details>",
].join("\n");

test("a Dependabot body renders as a collapsible section, not raw tags", () => {
  const html = renderToStaticMarkup(createElement(HostingBody as never, { host, text: DEPENDABOT, keyBase: "body" }));
  assert.match(html, /<details[^>]*class="pr-details"/);
  assert.match(html, /<summary>Release notes<\/summary>/);
  assert.match(html, /<h2[^>]*>(?:<span>)?v7\.0\.1(?:<\/span>)?<\/h2>/);
  assert.match(html, /<li[^>]*>.*skip the unsafe check by /);
  assert.match(html, /<a [^>]*href="https:\/\/github\.com\/aiqiaoy"[^>]*>/);
  // The tags the provider sent never reach the page as text.
  assert.doesNotMatch(html, /&lt;\/?(?:details|summary|p|em|ul|li|a|code|h2)\b/);
  assert.doesNotMatch(html, /<p[^>]*>Bump actions\/checkout from 4\.4\.0 to 7\.0\.1\s*&lt;/);
});
