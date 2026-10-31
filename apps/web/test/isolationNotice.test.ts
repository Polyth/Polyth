// The isolation lifecycle notice is a transcript milestone: the merge names its
// target branch and result commit as chips, the branch lands where the locale's
// sentence puts it, and the whole row keeps one accessible sentence.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

register("./tsxHooks.mjs", import.meta.url);

const { default: IsolationNotice } = await import("../src/components/IsolationNotice.tsx");
const { setLocale } = await import("../src/i18n/index.ts");
type Notice = Parameters<typeof IsolationNotice>[0]["notice"];

const notice = (patch: Partial<Notice>): Notice => ({
  kind: "notice",
  id: "ev-1",
  eventSeq: 1,
  topic: "isolation-merged",
  time: 0,
  ...patch,
});

test("a merge renders a branch chip and a copyable commit chip", () => {
  const html = renderToStaticMarkup(createElement(IsolationNotice, { notice: notice({ branch: "master", commit: "2b84b86" }) }));
  assert.match(html, /class="task-activity isolation-notice isolation-notice--merged"/);
  assert.match(html, />Merged into</);
  assert.match(html, /isolation-notice-branch[^>]*title="master"/);
  assert.match(html, /<button type="button" class="isolation-notice-chip isolation-notice-commit"/);
  assert.match(html, />2b84b86</);
  // The commit is its own chip, not a technical "· sha" suffix.
  assert.doesNotMatch(html, /·/);
});

test("the branch chip follows the locale's word order", async () => {
  await setLocale("de");
  try {
    const html = renderToStaticMarkup(createElement(IsolationNotice, { notice: notice({ branch: "main", commit: "abc1234" }) }));
    const branch = html.indexOf("isolation-notice-branch");
    assert.ok(html.indexOf(">In<") < branch && branch < html.indexOf(">zusammengeführt<"));
  } finally {
    await setLocale("en");
  }
});

test("returned and discarded notices use their own tone and no chips", () => {
  const returned = renderToStaticMarkup(createElement(IsolationNotice, { notice: notice({ topic: "isolation-discarded", returned: true }) }));
  assert.match(returned, /isolation-notice--returned/);
  assert.match(returned, /Returned to original workspace/);
  assert.doesNotMatch(returned, /isolation-notice-chip/);
  const discarded = renderToStaticMarkup(createElement(IsolationNotice, { notice: notice({ topic: "isolation-discarded" }) }));
  assert.match(discarded, /isolation-notice--discarded/);
  assert.match(discarded, /Isolated workspace discarded/);
});

test("moving into isolation names the branch it came from and what stayed behind", () => {
  const started = renderToStaticMarkup(createElement(IsolationNotice, { notice: notice({ topic: "isolation-started", branch: "main", uncommitted: 2 }) }));
  assert.match(started, /isolation-notice--started/);
  assert.match(started, />Isolated from</);
  assert.match(started, /isolation-notice-branch[^>]*title="main"/);
  assert.match(started, /isolation-notice-note[^>]*>Uncommitted files left behind: 2</);
  assert.doesNotMatch(started, /isolation-notice-commit/);
  const clean = renderToStaticMarkup(createElement(IsolationNotice, { notice: notice({ topic: "isolation-started", branch: "main" }) }));
  assert.doesNotMatch(clean, /isolation-notice-note/);
});
