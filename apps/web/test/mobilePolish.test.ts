import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

register("./tsxHooks.mjs", import.meta.url);

const { summarizeUnifiedDiff } = await import("../src/components/PendingChangesBar.tsx");
const { stripCursorMarkers } = await import("../src/components/PullRequestView.tsx");
const { shellCardCopyText } = await import("../src/components/Timeline.tsx");
const { modelModalities } = await import("../src/components/ModelPicker.tsx");
const { parseMarkdown } = await import("../src/markdown/parse.ts");
const { renderBlocks } = await import("../src/markdown/render.tsx");
const { createElement, Fragment } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

test("workspace diff totals count content without file headers", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    " unchanged",
    "-old",
    "+new",
    "+another",
    "",
  ].join("\n");
  assert.deepEqual(summarizeUnifiedDiff(diff), { additions: 2, deletions: 1 });
});

test("pull request markdown removes Cursor markers but preserves other comments and fenced code", () => {
  assert.equal(
    stripCursorMarkers([
      "<!-- CURSOR_METADATA_START -->",
      "## Summary",
      "- keeps **GFM** content",
      "<!-- internal note preserved -->",
      "CURSOR_REVIEW_MARKER",
      "```html",
      "<!-- CURSOR_METADATA_START -->",
      "```",
    ].join("\n")),
    [
      "## Summary",
      "- keeps **GFM** content",
      "<!-- internal note preserved -->",
      "",
      "```html",
      "<!-- CURSOR_METADATA_START -->",
      "```",
    ].join("\n"),
  );
});

test("GFM task-list items render as checked and unchecked controls", () => {
  const blocks = parseMarkdown("- [x] shipped\n- [ ] follow up");
  assert.equal(blocks[0]?.kind, "list");
  if (blocks[0]?.kind !== "list") throw new Error("expected list");
  assert.deepEqual(blocks[0].items.map((item) => item.checked), [true, false]);
  const html = renderToStaticMarkup(createElement(Fragment, null, ...renderBlocks(blocks, "tasks")));
  assert.match(html, /class="md-task-list"/);
  assert.match(html, /type="checkbox"[^>]*checked=""/);
  assert.match(html, /type="checkbox"[^>]*disabled=""/);
  assert.doesNotMatch(html, /\[x\]|\[ \]/);
});

test("shell card copy combines the command and its result", () => {
  assert.equal(
    shellCardCopyText({ command: "npm test" }, "started\npid 42"),
    "npm test\n\nstarted\npid 42",
  );
  assert.equal(shellCardCopyText({ argv: ["npm", "test"] }), '{\n  "argv": [\n    "npm",\n    "test"\n  ]\n}');
});

test("model metadata reports deduplicated input and output modalities", () => {
  assert.equal(modelModalities({
    providerID: "test",
    modelID: "vision",
    name: "Vision",
    capabilities: ["input:text", "input:image", "output:image", "toolcall"],
  }), "Text, Image");
});

test("fresh mobile sessions expose project and branch targets", () => {
  const surface = read("../src/components/workspace/builtinSurfaces.tsx");
  const contextBar = read("../src/components/mobile/SessionContextBar.tsx");
  const composer = read("../src/components/Composer.tsx");
  const actions = read("../src/widgets/builtinMiniWidgets.tsx");
  const header = read("../src/components/Header.tsx");
  const css = read("../src/styles.css");

  // UX-MOBILE-01 §5: the selectors moved out of the middle of the page into
  // the compact context bar above the composer — without losing either target.
  assert.match(surface, /<SessionContextBar/);
  assert.match(contextBar, /Project for new session, current \$\{projectName\}/);
  assert.match(contextBar, /Branch for new session, current \$\{branchName\}/);
  assert.match(surface, /target: \{ kind: "branch", branch: candidate\.name \}/);
  assert.match(composer, /newSessionTarget\.kind === "branch"/);
  assert.doesNotMatch(composer, /Modalities:/);
  assert.match(composer, /aria-label="Add files"/);
  assert.match(actions, /composer-auto-approve/);
  assert.match(actions, /composer-goals/);
  assert.match(header, /displaySessionTitle\(session\.title, session\.id, firstUserText\)/);
  assert.match(header, /Composer controls/);
  assert.match(css, /\.polyth-gradient\s*\{[^}]*linear-gradient/s);
});

test("source-control surfaces keep responsive and accessible audit contracts", () => {
  const git = read("../src/components/GitView.tsx");
  const github = read("../src/components/GithubView.tsx");
  const pullRequest = read("../src/components/PullRequestView.tsx");
  const pending = read("../src/components/PendingChangesBar.tsx");
  const css = read("../src/styles.css");

  assert.match(css, /container:\s*source-surface\s*\/\s*inline-size/);
  assert.match(css, /@container source-surface \(max-width: 700px\)[\s\S]*\.git-master-detail/);
  assert.match(css, /@container source-surface \(max-width: 599px\)[\s\S]*\.gh-card-overflow/);
  assert.match(git, /aria-pressed=\{prefs\.layout === "unified"\}/);
  assert.doesNotMatch(git, /window\.confirm/);
  assert.match(git, /Couldn’t load the file diff/);
  assert.match(github, /aria-pressed=\{filter === item\.id\}/);
  assert.match(pullRequest, /reviewBusy/);
  assert.match(pullRequest, /<MarkdownDoc/);
  assert.doesNotMatch(pending, /<details/);
  assert.match(pending, /aria-haspopup="menu"/);
});
