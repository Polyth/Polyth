import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bookmarkExportFileName,
  bookmarksMarkdown,
  compareBookmarks,
  deriveBookmarkTitle,
  extractBookmarkLinks,
  extractBookmarkSection,
  parseBookmarkDocument,
  parseBookmarkInput,
  parseBookmarkPatch,
  type Bookmark,
} from "../src/bookmarks.ts";

const bookmark = (patch: Partial<Bookmark>): Bookmark => ({
  id: "a",
  kind: "answer",
  projectId: "p",
  sessionId: "s",
  eventSeq: 1,
  title: "T",
  links: [],
  edited: false,
  createdAt: 0,
  updatedAt: 0,
  revision: 1,
  ...patch,
});

test("a title is the first heading, else the first line, without its marks", () => {
  assert.equal(deriveBookmarkTitle("Intro\n\n## **Що** обрати\n\nText"), "Що обрати");
  assert.equal(deriveBookmarkTitle("- Use [restic](https://restic.net) *first*\nmore"), "Use restic first");
  assert.equal(deriveBookmarkTitle("```\n# not a heading\n```\nReal line"), "Real line");
  assert.equal(deriveBookmarkTitle("   \n"), "");
  assert.ok(deriveBookmarkTitle("x".repeat(400)).length <= 120);
});

test("links keep their text and reading order, once each, and skip code", () => {
  const links = extractBookmarkLinks([
    "See [restic docs](https://restic.net/docs) and https://borgbackup.org.",
    "`https://inline.example/code`",
    "```",
    "https://fenced.example/code",
    "```",
    "Again [other text](https://restic.net/docs), then (https://en.wikipedia.org/wiki/Foo_(bar)).",
    "[bad](javascript:alert(1)) <https://auto.example/a>",
  ].join("\n"));
  assert.deepEqual(links.map((link) => link.url), [
    "https://restic.net/docs",
    "https://borgbackup.org/",
    "https://en.wikipedia.org/wiki/Foo_(bar)",
    "https://auto.example/a",
  ]);
  assert.equal(links[0]!.label, "restic docs");
  assert.equal(links[1]!.label, "borgbackup.org");
});

test("a section runs to the next heading of its level and ignores fenced headings", () => {
  const text = "Intro\n\n## Перший **розділ**\nТекст\n\n### Глибше\nЩе\n\n```\n## Не заголовок\n```\n\n## Другий\nІнше";
  assert.equal(extractBookmarkSection(text, "Перший розділ"), "## Перший **розділ**\nТекст\n\n### Глибше\nЩе\n\n```\n## Не заголовок\n```");
  assert.equal(extractBookmarkSection(text, "глибше"), "### Глибше\nЩе\n\n```\n## Не заголовок\n```");
  assert.equal(extractBookmarkSection(text, "Другий"), "## Другий\nІнше");
  assert.equal(extractBookmarkSection(text, "Не заголовок"), null);
  assert.equal(extractBookmarkSection(text, ""), null);
});

test("input names its place and stays inside the limits", () => {
  assert.deepEqual(parseBookmarkInput({ kind: "answer", sessionId: "s", eventSeq: 4, body: "# Head\nText" }), {
    kind: "answer", sessionId: "s", eventSeq: 4, title: "Head", body: "# Head\nText",
  });
  assert.equal(parseBookmarkInput({ kind: "note", projectId: "p", note: "Remember this" }).title, "Remember this");
  for (const raw of [
    null,
    { kind: "nope", sessionId: "s", eventSeq: 1, body: "x" },
    { kind: "answer", eventSeq: 1, body: "x" },
    { kind: "answer", sessionId: "s", eventSeq: 0, body: "x" },
    { kind: "answer", sessionId: "s", eventSeq: 1, body: "   " },
    { kind: "note", body: "x" },
    { kind: "answer", sessionId: "s", eventSeq: 1, body: "x".repeat(512 * 1024 + 1) },
    { kind: "answer", sessionId: "s", eventSeq: 1, body: "x", note: "n".repeat(20_001) },
  ]) {
    assert.throws(() => parseBookmarkInput(raw), { code: "invalid-input" });
  }
});

test("a patch may clear a note but never a title", () => {
  assert.deepEqual(parseBookmarkPatch({ note: "" }), { note: "" });
  assert.throws(() => parseBookmarkPatch({ title: "  " }), { code: "invalid-input" });
});

test("a stored note keeps its chat without a message", () => {
  const document = parseBookmarkDocument({
    bookmarks: [bookmark({ id: "n", kind: "note", eventSeq: undefined })],
  });
  assert.equal(document.bookmarks[0]?.sessionId, "s");
  assert.equal(document.bookmarks[0]?.eventSeq, undefined);
});

test("a damaged stored entry drops out, the rest stay", () => {
  const document = parseBookmarkDocument({
    revision: 3,
    bookmarks: [
      bookmark({ id: "good" }),
      { id: "../evil", kind: "answer", projectId: "p", title: "x" },
      { id: "chatless", kind: "answer", projectId: "p", title: "x" },
      "junk",
    ],
  });
  assert.deepEqual(document.bookmarks.map((entry) => entry.id), ["good"]);
  assert.equal(document.revision, 3);
});

test("order is chat order within a chat, notes last", () => {
  const sorted = [
    bookmark({ id: "note", kind: "note", sessionId: undefined, eventSeq: undefined, createdAt: 9 }),
    bookmark({ id: "later", eventSeq: 9, createdAt: 1 }),
    bookmark({ id: "earlier", eventSeq: 2, createdAt: 5 }),
    bookmark({ id: "chat-note", kind: "note", eventSeq: undefined, createdAt: 2 }),
  ].sort(compareBookmarks);
  assert.deepEqual(sorted.map((entry) => entry.id), ["earlier", "later", "chat-note", "note"]);
});

test("export reads as one document grouped by chat", () => {
  const markdown = bookmarksMarkdown({
    title: "Project",
    items: [
      { bookmark: bookmark({ id: "b", eventSeq: 5, title: "Second", chatTitle: "Backups", createdAt: 0 }), body: "Two" },
      { bookmark: bookmark({ id: "a", eventSeq: 2, title: "First", chatTitle: "Backups", note: "mine\n\nline" }), body: "One [l](https://a.example)" },
    ],
  });
  assert.match(markdown, /^# Project\n\n## Backups\n\n### First\n/);
  assert.equal(markdown.match(/^## /gm)?.length, 1);
  assert.match(markdown, /> mine\n>\n> line\n\nOne \[l\]\(https:\/\/a\.example\)/);
  assert.ok(markdown.indexOf("### First") < markdown.indexOf("### Second"));
});

test("an export file name is safe on every system", () => {
  const at = Date.UTC(2026, 10, 6);
  assert.equal(bookmarkExportFileName("Огляд / бекапів: restic?", at), "bookmarks-огляд-бекапів-restic-2026-11-06.md");
  assert.equal(bookmarkExportFileName("../..", at), "bookmarks-2026-11-06.md");
});
