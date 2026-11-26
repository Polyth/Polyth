#!/usr/bin/env node
// Pull request screenshot check: a pull request that changes what a person can
// see (web CSS, TSX, HTML or SVG outside tests) must show it — an image in its
// body (`node scripts/pr-screenshots.mjs` adds them, or drag-and-drop on
// GitHub) — or say why not with a `No visible change: <reason>` line.
// Promotions from devel to master are not checked: their changes were checked
// when they entered devel.
//
// Usage: PR_BODY=… [BASE_REF=… HEAD_REF=…] node scripts/ci/check-pr-screenshots.mjs <base-sha> <head-sha>
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const UI_FILE = /\.(css|tsx|html|svg)$/i;
const UI_ROOT = /^(apps|packages)\//;
const NOT_UI = [/(^|\/)tests?\//, /(^|\/)__tests__\//, /\.(test|spec|stories)\.[^/]+$/, /(^|\/)fixtures?\//];

/** Changed paths a person can see when they change. */
export const visibleUiFiles = (paths) => paths.filter((path) =>
  UI_ROOT.test(path) && UI_FILE.test(path) && !NOT_UI.some((pattern) => pattern.test(path)));

// Repeat until nothing changes: one pass over `<!<!-- -->-- … -->` leaves a
// comment GitHub still hides.
const withoutComments = (body) => {
  let text = body ?? "";
  for (let previous; previous !== text;) {
    previous = text;
    text = text.replace(/<!--[\s\S]*?-->/g, "");
  }
  return text;
};

/** Whether the body shows at least one image (Markdown or HTML). */
export const bodyHasScreenshot = (body) => {
  const text = withoutComments(body);
  return /!\[[^\]]*\]\(\s*<?(https?:\/\/|\.{0,2}\/)[^)\s]+/i.test(text) || /<img\s[^>]*\bsrc\s*=\s*["']?https?:\/\//i.test(text);
};

/** The stated reason when the body declares there is nothing to see, or null. */
export const noVisibleChangeReason = (body) => {
  const match = /^\s*(?:[-*]\s*)?no visible (?:ui )?change\s*[:—-]\s*(\S.*)$/im.exec(withoutComments(body));
  return match ? match[1].trim() : null;
};

/** null when the pull request passes, otherwise the error text. */
export function checkPullRequest({ body, files, baseRef = "", headRef = "" }) {
  if (headRef === "devel" && baseRef === "master") return null;
  const visible = visibleUiFiles(files);
  if (!visible.length || bodyHasScreenshot(body) || noVisibleChangeReason(body)) return null;
  const shown = visible.slice(0, 10).map((path) => `  ${path}`);
  if (visible.length > shown.length) shown.push(`  … and ${visible.length - shown.length} more`);
  return [
    "This pull request changes visible UI but its description shows no screenshot:",
    ...shown,
    "",
    "Attach the before/after screenshots you captured (they are under .scratch/):",
    "  node scripts/pr-screenshots.mjs",
    "or add a line `No visible change: <reason>` when nothing a person sees changed.",
    "See docs/agents/verification.md#screenshots-in-pull-requests.",
  ].join("\n");
}

export const changedFiles = (base, head) => execFileSync(
  "git",
  ["diff", "--name-only", "--no-renames", `${base}...${head}`],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
).split("\n").filter(Boolean);

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("usage: PR_BODY=… check-pr-screenshots.mjs <base-sha> <head-sha>");
    process.exit(2);
  }
  const files = changedFiles(base, head);
  const error = checkPullRequest({
    body: process.env.PR_BODY ?? "",
    files,
    baseRef: process.env.BASE_REF ?? "",
    headRef: process.env.HEAD_REF ?? "",
  });
  if (error) {
    console.error(`::error::Visible UI change without screenshots\n${error}`);
    process.exit(1);
  }
  console.log(`PR screenshots: ${files.length} changed file(s), ${visibleUiFiles(files).length} visible UI file(s); ok.`);
}
