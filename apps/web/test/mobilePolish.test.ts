import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatList, tr } from "../src/i18n/index.ts";

register("./tsxHooks.mjs", import.meta.url);

const { summarizeUnifiedDiff } = await import("../../../packages/git/widgets/PendingChangesBar.tsx");
const { reviewMessageTone, stripCursorMarkers } = await import("../../../packages/github/widgets/PullRequestView.tsx");
const { shellCardCopyText } = await import("../src/components/Timeline.tsx");
const { modelModalities } = await import("../../../packages/models/widgets/ModelPicker.tsx");
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

test("pull request markdown hides HTML comments and the Cursor footer outside code fences", () => {
  const cleaned = stripCursorMarkers([
    "<!-- CURSOR_AGENT_PR_BODY_BEGIN -->",
    "## Summary",
    "- keeps **GFM** content",
    "<!-- ordinary internal note -->",
    "CURSOR_REVIEW_MARKER",
    '<div><a href="https://cursor.com/agents/bc-123?cursor_ref=pr_footer&cursor_cta=open_in_web">Open in Web</a></div>',
    "```html",
    "<!-- shown as a code example -->",
    "```",
    "<!-- CURSOR_AGENT_PR_BODY_END -->",
  ].join("\n"));

  assert.match(cleaned, /## Summary/);
  assert.doesNotMatch(cleaned, /ordinary internal note|CURSOR_REVIEW_MARKER|cursor_ref=pr_footer|Open in Web/);
  assert.match(cleaned, /<!-- shown as a code example -->/);

  const html = renderToStaticMarkup(createElement(Fragment, null, ...renderBlocks(parseMarkdown(cleaned), "pr-body")));
  assert.doesNotMatch(html, /ordinary internal note|CURSOR_REVIEW_MARKER|Open in Web/);
  assert.match(html, /shown as a code example/);
});

test("blocked reviews use warning semantics instead of success styling", () => {
  assert.equal(reviewMessageTone("Confirm the approval or change request before submitting."), "warning");
  assert.equal(reviewMessageTone("Submit failed: unavailable"), "error");
  assert.equal(reviewMessageTone("Review submitted (approve)."), "success");
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
  }), formatList([tr("modelpicker.text"), tr("modelpicker.image")]));
});

test("all mobile chat composers expose project and worktree targets", () => {
  const surface = read("../src/components/workspace/builtinSurfaces.tsx");
  const contextBar = read("../src/components/mobile/SessionContextBar.tsx");
  const composer = read("../src/components/Composer.tsx");
  const actions = [
    read("../../../packages/permissions/widgets/index.tsx"),
    read("../../../packages/goals/widgets/index.tsx"),
  ].join("\n");
  const workflowLauncher = read("../../../packages/workflow/widgets/WorkflowLauncher.tsx");
  const header = read("../src/components/Header.tsx");
  const css = read("../src/styles.css");

  // UX-MOBILE-01 §5: the compact context bar belongs to the shared composer,
  // so fresh and existing chats cannot assemble different control sets.
  assert.doesNotMatch(surface, /<SessionContextBar/);
  assert.match(composer, /<SessionContextBar \{\.\.\.contextBar\} \/>/);
  assert.match(contextBar, /tr\("mobile\.sessioncontextbar\.projectCurrentValue"/);
  assert.match(contextBar, /tr\("mobile\.sessioncontextbar\.worktreeCurrentValue"/);
  assert.match(composer, /target: \{ kind: "branch", branch: candidate\.name \}/);
  assert.match(composer, /newSessionTarget\.kind === "branch"/);
  assert.doesNotMatch(composer, /Modalities:/);
  assert.match(composer, /aria-label=\{tr\("composer\.addFiles"\)\}/);
  assert.match(actions, /composer-auto-approve/);
  assert.match(actions, /composer-goals/);
  assert.match(workflowLauncher, /composer-workflow/);
  assert.match(css, /\.composer-mobile \.composer-workflow,/);
  assert.match(css, /\.composer-mobile \.composer-workflow:active,/);
  assert.match(css, /\.composer\.composer-mobile \.composer-mobile-extensions \.composer-workflow\s*\{[^}]*width:\s*var\(--tap\);[^}]*min-width:\s*var\(--tap\);/s);
  assert.match(css, /\.composer-mobile\.composer-collapsed:not\(\.composer-has-draft\) \.composer-workflow \{ display: none; \}/);
  assert.match(css, /\.composer-mobile\.composer-has-draft \.composer-workflow \{ display: inline-flex; \}/);
  assert.match(header, /displaySessionTitle\(session\.title, session\.id, firstUserText\)/);
  const phoneStart = header.indexOf('if (mode === "phone" && chatSurface)');
  const phoneEnd = header.indexOf("\n  return (", phoneStart);
  const phoneHeader = header.slice(phoneStart, phoneEnd);
  assert.match(phoneHeader, /<DrawerTrigger \/>/);
  assert.match(phoneHeader, /className="mobile-session-title"/);
  assert.match(phoneHeader, /<CompactViewPicker view=\{view\} \/>/);
  assert.match(phoneHeader, /className="icon-btn mobile-header-action mobile-header-more"/);
  assert.match(phoneHeader, /slot="session\.header\.actions"/);
  assert.match(phoneHeader, /slot="app\.header\.actions"/);
  assert.doesNotMatch(phoneHeader, /refreshSessions|MobileComposerControlsMenu|<UserMenu/,
    "secondary utilities stay in the More sheet instead of crowding the top bar");
  assert.doesNotMatch(header, /MobileComposerControlsMenu/);
  assert.match(header, /triggerIcon=\{<Icon\.widgets \/>\}/);
  assert.match(css, /\.polyth-gradient\s*\{[^}]*linear-gradient/s);
});

test("source-control surfaces keep responsive and accessible audit contracts", () => {
  const git = read("../../../packages/git/widgets/GitView.tsx");
  const github = read("../../../packages/github/widgets/GithubView.tsx");
  const pullRequest = read("../../../packages/github/widgets/PullRequestView.tsx");
  const pending = read("../../../packages/git/widgets/PendingChangesBar.tsx");
  const css = read("../src/styles.css");

  assert.match(css, /container:\s*source-surface\s*\/\s*inline-size/);
  assert.match(css, /@container source-surface \(max-width: 700px\)[\s\S]*\.git-master-detail/);
  assert.match(css, /@container source-surface \(max-width: 599px\)[\s\S]*\.gh-card-overflow/);
  assert.match(git, /aria-pressed=\{prefs\.layout === "unified"\}/);
  assert.doesNotMatch(git, /window\.confirm/);
  assert.match(git, /tr\("gitview\.couldntLoadTheFileDiff"\)/);
  assert.match(github, /aria-pressed=\{filter === item\.id\}/);
  assert.match(pullRequest, /reviewBusy/);
  assert.match(pullRequest, /<MarkdownDoc/);
  assert.doesNotMatch(pending, /<details/);
  assert.match(
    pending,
    /aria-haspopup="menu"/,
  );
});
