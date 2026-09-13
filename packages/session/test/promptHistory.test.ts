import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionProjection } from "@polyth/contracts";
import { createStore } from "../src/index.ts";
import { parsePromptHistoryCandidate } from "../src/promptHistory.ts";

const tmpStore = () => createStore(join(mkdtempSync(join(tmpdir(), "polyth-ph-")), "s.db"));

const proj = (over: Partial<SessionProjection> & Pick<SessionProjection, "id" | "projectId" | "spaceId">): SessionProjection => ({
  title: over.id,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

test("prompt history is a scoped view over composer submissions with stable newest-last order", async () => {
  const store = tmpStore();
  await store.upsertProjection(proj({ id: "sA", projectId: "pA", spaceId: "space-1" }));
  await store.upsertProjection(proj({ id: "sB", projectId: "pB", spaceId: "space-1", worktreePath: "/wt/b" }));
  await store.upsertProjection(proj({ id: "sOther", projectId: "pX", spaceId: "space-2" }));

  await store.append("sA", "user/message", { text: "alpha" });
  await store.append("sA", "assistant/message", { partId: "p1", text: "ok" });
  await store.append("sA", "user/message", { text: "analyse these", attachments: [{
    id: "a1", name: "trace.log", mime: "text/plain", size: 12, kind: "file", path: "trace.log",
  }] });
  await store.append("sA", "tool/call", {
    callId: "c1", tool: "shell", input: { command: "git status" },
  }, { producerPlugin: "composer-shell" });
  await store.append("sA", "tool/call", {
    callId: "c2", tool: "shell", input: { command: "agent shell" },
  });
  await store.append("sB", "user/message", { text: "from B" });
  await store.append("sOther", "user/message", { text: "other space" });
  await store.append("sA", "user/message", { text: "hidden conflict", githubConflictResolution: true });
  await store.append("sA", "user/message", { text: "continue" });
  await store.append("sA", "user/message", { text: "continue" });

  const session = await store.listPromptHistory({ spaceId: "space-1", sessionId: "sA", limit: 40 });
  assert.deepEqual(session.map((e) => e.text), ["alpha", "analyse these", "!git status", "continue", "continue"]);
  assert.equal(session[1]!.attachments[0]!.name, "trace.log");
  assert.equal(session[1]!.projectId, "pA");
  assert.ok(session.every((e) => e.sessionId === "sA"));
  assert.ok(session.at(-1)!.seq > session[0]!.seq);
  assert.equal(session.some((e) => e.text === "!agent shell"), false);

  const space = await store.listPromptHistory({ spaceId: "space-1", limit: 40 });
  assert.deepEqual(space.map((e) => e.text), ["alpha", "analyse these", "!git status", "from B", "continue", "continue"]);
  assert.equal(space.find((e) => e.text === "from B")?.worktreePath, "/wt/b");
  assert.equal(space.some((e) => e.text === "other space"), false);

  const other = await store.listPromptHistory({ spaceId: "space-2", limit: 40 });
  assert.deepEqual(other.map((e) => e.text), ["other space"]);

  const leaked = await store.listPromptHistory({ spaceId: "space-1", sessionId: "sOther", limit: 40 });
  assert.deepEqual(leaked, []);

  const retained = await store.listPromptHistory({ spaceId: "space-1", sessionId: "sA", limit: 2 });
  assert.deepEqual(retained.map((e) => e.text), ["continue", "continue"]);
  assert.equal(retained[0]!.seq < retained[1]!.seq, true);

  await store.close();
});

test("prompt history retention drops the oldest retrieved rows without deleting events", async () => {
  const store = tmpStore();
  await store.upsertProjection(proj({ id: "s1", projectId: "p1", spaceId: "sp" }));
  for (const text of ["a", "b", "c", "d", "e"]) {
    await store.append("s1", "user/message", { text });
  }
  const kept = await store.listPromptHistory({ spaceId: "sp", sessionId: "s1", limit: 3 });
  assert.deepEqual(kept.map((e) => e.text), ["c", "d", "e"]);
  const all = await store.events("s1");
  assert.equal(all.filter((e) => e.type === "user/message").length, 5);
  await store.close();
});

test("prompt history fills the requested eligible count beyond the first raw chunk", async () => {
  const store = tmpStore();
  await store.upsertProjection(proj({ id: "s1", projectId: "p1", spaceId: "sp" }));
  for (let i = 0; i < 40; i++) await store.append("s1", "user/message", { text: `keep-${i}` });
  for (let i = 0; i < 80; i++) {
    await store.append("s1", "user/message", { text: `skip-${i}`, githubConflictResolution: true });
  }
  const kept = await store.listPromptHistory({ spaceId: "sp", sessionId: "s1", limit: 40 });
  assert.equal(kept.length, 40);
  assert.equal(kept[0]!.text, "keep-0");
  assert.equal(kept.at(-1)!.text, "keep-39");
  await store.close();
});

test("prompt history can recall the newest 40 eligible prompts without a hydrated timeline", async () => {
  const store = tmpStore();
  await store.upsertProjection(proj({ id: "s1", projectId: "p1", spaceId: "sp" }));
  for (let i = 0; i < 45; i++) {
    await store.append("s1", "user/message", { text: `p-${i}` });
    await store.append("s1", "assistant/message", { partId: `a${i}`, text: "ok" });
    await store.append("s1", "tool/call", { callId: `t${i}`, tool: "read", input: { path: "x" } });
    await store.append("s1", "tool/result", { callId: `t${i}`, tool: "read", output: "x" });
  }
  const all = await store.events("s1");
  assert.ok(all.length > 40, "durable log is deeper than the UI window");
  const kept = await store.listPromptHistory({ spaceId: "sp", sessionId: "s1", limit: 40 });
  assert.equal(kept.length, 40);
  assert.equal(kept[0]!.text, "p-5");
  assert.equal(kept.at(-1)!.text, "p-44");
  await store.close();
});

test("prompt history respects canonical rewind hiding", async () => {
  const store = tmpStore();
  await store.upsertProjection(proj({ id: "s1", projectId: "p1", spaceId: "sp" }));
  await store.append("s1", "user/message", { text: "keep" });
  const hiddenStart = await store.append("s1", "user/message", { text: "hidden-a" });
  await store.append("s1", "user/message", { text: "hidden-b" });
  await store.append("s1", "session/rewound", { atSeq: hiddenStart.seq });
  await store.append("s1", "user/message", { text: "after-rewind" });
  const active = await store.listPromptHistory({ spaceId: "sp", sessionId: "s1", limit: 40 });
  assert.deepEqual(active.map((e) => e.text), ["keep"]);

  await store.append("s1", "session/rewind-cleared", { replaced: true });
  await store.append("s1", "user/message", { text: "after-replace" });
  const replaced = await store.listPromptHistory({ spaceId: "sp", sessionId: "s1", limit: 40 });
  assert.deepEqual(replaced.map((e) => e.text), ["keep", "after-replace"]);
  await store.close();
});

test("parsePromptHistoryCandidate skips junk, conflicts, and empty payloads", () => {
  const entries = [
    {
      sessionId: "s", projectId: "p", worktreePath: null, seq: 4, id: "4", time: 4, type: "user/message",
      data: JSON.stringify({
        text: "hello",
        attachments: [{ id: "a1", name: "a.txt", mime: "text/plain", size: 1, path: "a.txt", extra: true }],
      }),
    },
    { sessionId: "s", projectId: "p", worktreePath: null, seq: 3, id: "3", time: 3, type: "user/message", data: "not-json" },
    {
      sessionId: "s", projectId: "p", worktreePath: null, seq: 2, id: "2", time: 2, type: "user/message",
      data: JSON.stringify({ text: "hidden", githubConflictResolution: true }),
    },
    { sessionId: "s", projectId: "p", worktreePath: null, seq: 1, id: "1", time: 1, type: "user/message", data: JSON.stringify({ text: "  ", attachments: [] }) },
  ].map(parsePromptHistoryCandidate).filter((entry) => entry !== null);
  assert.deepEqual(entries.map((e) => e.text), ["hello"]);
  assert.equal(entries[0]!.attachments[0]!.name, "a.txt");
  assert.equal("extra" in entries[0]!.attachments[0]!, false);
});

test("prompt history preserves durable browser-context attachments", async () => {
  const store = tmpStore();
  await store.upsertProjection(proj({ id: "sA", projectId: "pA", spaceId: "sp" }));
  const browserContext = {
    extra: true,
    id: "ctx-el",
    type: "element" as const,
    browserSessionId: "b1",
    projectId: "pA",
    sessionId: "sA",
    frameRevision: 2,
    url: "https://example.com/settings",
    title: "Settings",
    viewport: { width: 390, height: 844 },
    capturedAt: "2026-09-06T00:00:00.000Z",
    note: "look here",
    quote: "Save changes",
    element: {
      tag: "button", role: "button", name: "Save", selector: "#save", text: "Save",
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      attributes: { type: "submit" },
    },
    region: {
      normalized: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      pixels: { x: 10, y: 20, width: 30, height: 40 },
    },
    intersecting: [{ tag: "form", selector: "form" }],
    textSummary: "visible",
    accessibilitySummary: "a11y",
    contentHash: "abc",
    screenshot: { id: "shot-1", mime: "image/jpeg", size: 12, localPath: "/secret/shot.jpg" },
    crop: { id: "crop-1", mime: "image/jpeg", size: 8 },
  };
  await store.append("sA", "user/message", {
    text: "inspect this",
    attachments: [{
      id: "ctx-el",
      name: "Save",
      mime: "application/vnd.polyth.browser-context+json",
      size: 8,
      kind: "browser-context",
      extra: true,
      url: "/api/browser/artifacts?id=crop-1",
      browserContext,
    }],
  });
  const kept = await store.listPromptHistory({ spaceId: "sp", sessionId: "sA", limit: 40 });
  assert.equal(kept.length, 1);
  const att = kept[0]!.attachments[0]!;
  assert.equal(att.kind, "browser-context");
  assert.equal(att.url, "/api/browser/artifacts?id=crop-1");
  assert.equal("extra" in att, false);
  assert.equal(att.path, undefined);
  const ctx = att.browserContext!;
  assert.equal(ctx.id, "ctx-el");
  assert.equal(ctx.type, "element");
  assert.equal(ctx.browserSessionId, "b1");
  assert.equal(ctx.projectId, "pA");
  assert.equal(ctx.sessionId, "sA");
  assert.equal(ctx.frameRevision, 2);
  assert.equal(ctx.url, "https://example.com/settings");
  assert.equal(ctx.title, "Settings");
  assert.deepEqual(ctx.viewport, { width: 390, height: 844 });
  assert.equal(ctx.capturedAt, "2026-09-06T00:00:00.000Z");
  assert.equal(ctx.note, "look here");
  assert.equal(ctx.quote, "Save changes");
  assert.deepEqual(ctx.element, browserContext.element);
  assert.deepEqual(ctx.region, browserContext.region);
  assert.deepEqual(ctx.intersecting, browserContext.intersecting);
  assert.equal(ctx.textSummary, "visible");
  assert.equal(ctx.accessibilitySummary, "a11y");
  assert.equal(ctx.contentHash, "abc");
  assert.deepEqual(ctx.screenshot, { id: "shot-1", mime: "image/jpeg", size: 12 });
  assert.equal("localPath" in (ctx.screenshot ?? {}), false);
  assert.deepEqual(ctx.crop, { id: "crop-1", mime: "image/jpeg", size: 8 });
  assert.equal("extra" in ctx, false);
  await store.close();
});

test("malformed composer-shell tool/call JSON does not 500 prompt history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-ph-malformed-"));
  const dbPath = join(dir, "s.db");
  const store = createStore(dbPath);
  await store.upsertProjection(proj({ id: "s1", projectId: "p1", spaceId: "sp" }));
  await store.append("s1", "user/message", { text: "keep-before" });
  const raw = new DatabaseSync(dbPath);
  try {
    const next = (raw.prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = 's1'",
    ).get() as { next: number }).next;
    raw.prepare(
      `INSERT INTO events (session_id, seq, id, time, type, data, ignorable, producer, v)
       VALUES ('s1', ?, 'bad-json', ?, 'tool/call', 'not-json', 0, 'composer-shell', 1)`,
    ).run(next, Date.now());
    let extractAborted = false;
    try {
      raw.prepare("SELECT json_extract(data, '$.tool') FROM events WHERE id = 'bad-json'").get();
    } catch {
      extractAborted = true;
    }
    // Prefer the environment where json_extract aborts; either way the history
    // query below must not fail.
    void extractAborted;
  } finally {
    raw.close();
  }
  await store.append("s1", "tool/call", {
    callId: "not-shell", tool: "read", input: { path: "x" },
  }, { producerPlugin: "composer-shell" });
  await store.append("s1", "user/message", { text: "keep-after" });
  await store.append("s1", "tool/call", {
    callId: "ok", tool: "shell", input: { command: "echo ok" },
  }, { producerPlugin: "composer-shell" });
  const kept = await store.listPromptHistory({ spaceId: "sp", sessionId: "s1", limit: 40 });
  assert.deepEqual(kept.map((e) => e.text), ["keep-before", "keep-after", "!echo ok"]);
  const space = await store.listPromptHistory({ spaceId: "sp", limit: 40 });
  assert.deepEqual(space.map((e) => e.text), ["keep-before", "keep-after", "!echo ok"]);
  await store.close();
});

test("space-wide prompt history loads rewind hiders only for scanned sessions", async () => {
  const store = tmpStore();
  await store.upsertProjection(proj({ id: "sKeep", projectId: "p1", spaceId: "sp" }));
  await store.upsertProjection(proj({ id: "sHide", projectId: "p1", spaceId: "sp" }));
  await store.append("sKeep", "user/message", { text: "visible-a" });
  const hiddenStart = await store.append("sHide", "user/message", { text: "hidden-a" });
  await store.append("sHide", "user/message", { text: "hidden-b" });
  await store.append("sHide", "session/rewound", { atSeq: hiddenStart.seq });
  await store.append("sHide", "user/message", { text: "visible-b" });
  const space = await store.listPromptHistory({ spaceId: "sp", limit: 40 });
  assert.deepEqual(space.map((e) => e.text), ["visible-a"]);
  await store.close();
});

test("prompt history recalls every BrowserContext kind and skips unusable payloads", async () => {
  const store = tmpStore();
  await store.upsertProjection(proj({ id: "s1", projectId: "p1", spaceId: "sp" }));
  const base = {
    browserSessionId: "b1",
    projectId: "pA",
    frameRevision: 1,
    url: "https://example.com",
    title: "Example",
    viewport: { width: 800, height: 600 },
    capturedAt: "2026-09-06T00:00:00.000Z",
  };
  const kinds = [
    { id: "page", type: "page" as const, textSummary: "hello" },
    { id: "area", type: "area" as const, region: { normalized: { x: 0, y: 0, width: 1, height: 1 }, pixels: { x: 0, y: 0, width: 10, height: 10 } } },
    { id: "text", type: "text" as const, quote: "selected" },
  ];
  for (const kind of kinds) {
    await store.append("s1", "user/message", {
      text: kind.type,
      attachments: [{
        id: kind.id, name: kind.type, mime: "application/vnd.polyth.browser-context+json", size: 0,
        kind: "browser-context",
        browserContext: { ...base, ...kind },
      }],
    } as never);
  }
  await store.append("s1", "user/message", {
    text: "broken-context",
    attachments: [{
      id: "bad", name: "bad", mime: "application/vnd.polyth.browser-context+json", size: 0,
      kind: "browser-context",
      browserContext: { id: "bad", type: "page" },
    }],
  } as never);
  const kept = await store.listPromptHistory({ spaceId: "sp", sessionId: "s1", limit: 40 });
  assert.deepEqual(kept.map((e) => e.text), ["page", "area", "text", "broken-context"]);
  assert.deepEqual(kept.slice(0, 3).map((e) => e.attachments[0]?.browserContext?.type), ["page", "area", "text"]);
  assert.equal(kept[3]!.attachments.length, 0);
  assert.equal(kept[0]!.attachments[0]!.browserContext?.projectId, "pA");
  await store.close();
});
