import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserSessionDto } from "@polyth/contracts";
import { classifyPullRequest, extractMessageLinks, pullRequestLabel, readerParagraphs } from "../widgets/messageLinks.ts";
import { openUrlInBrowser, takePendingNavigation, type OpenInBrowserDeps } from "../widgets/openInBrowser.ts";

test("extracts distinct http(s) links, trimming prose and markdown punctuation", () => {
  const links = extractMessageLinks(
    "See https://example.com/a, and (https://example.com/b). Again https://example.com/a! [x](https://example.com/c) ftp://nope.test javascript:alert(1)",
  );
  assert.deepEqual(links.map((l) => l.url), ["https://example.com/a", "https://example.com/b", "https://example.com/c"]);
  assert.deepEqual(extractMessageLinks(null), []);
  assert.deepEqual(extractMessageLinks(""), []);
});

test("keeps balanced parentheses and refuses credentialed URLs", () => {
  assert.equal(extractMessageLinks("https://en.wikipedia.org/wiki/Foo_(bar).")[0]?.url, "https://en.wikipedia.org/wiki/Foo_(bar)");
  assert.deepEqual(extractMessageLinks("https://user:pass@example.com/x https://token@example.com/y"), []);
});

test("pull requests are recognized per provider and listed first", () => {
  const links = extractMessageLinks(
    "docs https://example.com/ then https://github.com/acme/app/pull/42/files and https://gitlab.com/g/sub/app/-/merge_requests/7 and https://bitbucket.org/a/b/pull-requests/3 and https://github.com/acme/app/issues/5",
  );
  assert.deepEqual(links.map((l) => pullRequestLabel(l)), ["acme/app #42", "g/sub/app !7", "a/b #3", null, null]);
  assert.equal(links[0]!.pullRequest?.provider, "github");
  assert.equal(classifyPullRequest(new URL("https://github.com/acme/app/pull/x")), undefined);
  assert.equal(classifyPullRequest(new URL("https://example.com/a/b/pull/1")), undefined);
});

test("link menu is bounded", () => {
  const text = Array.from({ length: 30 }, (_, i) => `https://example.com/${i}`).join(" ");
  assert.equal(extractMessageLinks(text).length, 8);
});

test("reader paragraphs collapse whitespace and blank runs", () => {
  assert.deepEqual(readerParagraphs("\n\n  Title \n\n\n\nA   b c\n\n"), ["Title", "", "A b c"]);
  assert.deepEqual(readerParagraphs("   \n  "), []);
});

const tab = (id: string, status: BrowserSessionDto["status"] = "ready", sessionId: string | undefined = "s1", projectId = "p"): BrowserSessionDto => ({
  id, projectId, sessionId, status, url: "about:blank", title: id,
  viewport: { width: 1280, height: 800, deviceScaleFactor: 1 }, colorScheme: "no-preference", revision: 1, engine: "fake",
});

function harness(tabs: BrowserSessionDto[], navigation: "ok" | "approval" = "ok") {
  const calls: string[] = [];
  const deps: OpenInBrowserDeps = {
    list: async () => tabs,
    create: async (input) => { calls.push(`create:${input.sessionId ?? "-"}`); const t = tab("new", "ready", input.sessionId); tabs.push(t); return t; },
    navigate: async (id, url) => {
      calls.push(`navigate:${id}:${url}`);
      return navigation === "ok" ? tab(id) : { approval: { message: "needs approval" } } as never;
    },
    recalledTab: () => null,
    rememberTab: (id) => calls.push(`remember:${id}`),
    openPane: () => calls.push("pane"),
  };
  return { calls, deps };
}

test("opening a link reuses this chat's live tab and never another lane's", async () => {
  const { calls, deps } = harness([tab("other", "ready", "s2"), tab("dead", "failed"), tab("mine")]);
  const result = await openUrlInBrowser({ projectId: "p", sessionId: "s1" }, "https://github.com/a/b/pull/1", deps);
  assert.deepEqual(result, { status: "opened", tabId: "mine" });
  assert.deepEqual(calls, ["remember:mine", "pane", "navigate:mine:https://github.com/a/b/pull/1"]);
});

test("a chat with no live tab gets a new one scoped to that session", async () => {
  const { calls, deps } = harness([tab("dead", "failed")]);
  const result = await openUrlInBrowser({ projectId: "p", sessionId: "s1" }, "https://example.com/", deps);
  assert.equal(result.status, "opened");
  assert.equal(calls[0], "create:s1");
});

test("approval-required links are parked for the viewer, not approved here", async () => {
  const { deps } = harness([tab("mine")], "approval");
  const result = await openUrlInBrowser({ projectId: "p", sessionId: "s1" }, "https://new-origin.test/", deps);
  assert.deepEqual(result, { status: "approval-required", tabId: "mine" });
  assert.equal(takePendingNavigation("mine"), "https://new-origin.test/");
  assert.equal(takePendingNavigation("mine"), null);
});

test("only http(s) URLs reach the browser", async () => {
  const { calls, deps } = harness([]);
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "not a url"]) {
    await assert.rejects(openUrlInBrowser({ projectId: "p", sessionId: null }, url, deps));
  }
  assert.deepEqual(calls, []);
});
