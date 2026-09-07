import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { AttachmentRef, PromptHistoryEntryDto } from "@polyth/contracts";
import {
  attachmentsForRecall,
  emptyPromptHistoryCursor,
  isBlockedAttachment,
  restorePromptHistoryDraft,
  shouldHandlePromptHistoryKey,
  stepPromptHistory,
} from "../src/composer/history.ts";

const entry = (over: Partial<PromptHistoryEntryDto> & Pick<PromptHistoryEntryDto, "id" | "text">): PromptHistoryEntryDto => ({
  sessionId: "s1",
  projectId: "p1",
  seq: 1,
  time: 1,
  attachments: [],
  ...over,
});

test("prompt history navigates by stable id, keeps duplicates, and restores the draft", () => {
  const draftAtt = [{ id: "d1", name: "draft.txt", mime: "text/plain", size: 4, kind: "file" as const, path: "draft.txt" }];
  const fileAtt = [{ id: "a1", name: "trace.log", mime: "text/plain", size: 8, kind: "file" as const, path: "trace.log" }];
  const items = [
    entry({ id: "u1", text: "continue", seq: 1, attachments: fileAtt }),
    entry({ id: "u2", text: "!git status", seq: 2 }),
    entry({ id: "u3", text: "continue", seq: 3 }),
  ];
  const draft = { text: "unsent draft", attachments: draftAtt };
  let step = stepPromptHistory(items, draft, emptyPromptHistoryCursor(), "up");
  assert.ok(step);
  assert.equal(step.text, "continue");
  assert.equal(step.cursor.entryId, "u3");
  step = stepPromptHistory(items, { text: step.text, attachments: step.attachments }, step.cursor, "up");
  assert.equal(step!.text, "!git status");
  step = stepPromptHistory(items, { text: step!.text, attachments: step!.attachments }, step!.cursor, "up");
  assert.equal(step!.text, "continue");
  assert.equal(step!.cursor.entryId, "u1");
  assert.equal(step!.attachments[0]!.path, "trace.log");
  const stuck = stepPromptHistory(items, { text: step!.text, attachments: step!.attachments }, step!.cursor, "up");
  assert.equal(stuck, null, "oldest entry does not wrap");
  step = stepPromptHistory(items, { text: step!.text, attachments: step!.attachments }, step!.cursor, "down");
  assert.equal(step!.text, "!git status");
  step = stepPromptHistory(items, { text: step!.text, attachments: step!.attachments }, step!.cursor, "down");
  assert.equal(step!.text, "continue");
  step = stepPromptHistory(items, { text: step!.text, attachments: step!.attachments }, step!.cursor, "down");
  assert.equal(step!.text, "unsent draft");
  assert.deepEqual(step!.attachments, draftAtt);
  assert.equal(step!.cursor.entryId, null);
  const restored = restorePromptHistoryDraft({
    entryId: "u1",
    draft: { text: "keep me", attachments: draftAtt },
  });
  assert.equal(restored!.text, "keep me");
  assert.deepEqual(restored!.attachments, draftAtt);
  const stripped = attachmentsForRecall(items[0]!, { projectId: "other" });
  stripped[0]!.path = "mutated";
  assert.equal(items[0]!.attachments[0]!.path, "trace.log");
});

test("stacked Up steps stay in order without wrapping", () => {
  const items = [
    entry({ id: "a", text: "oldest" }),
    entry({ id: "b", text: "mid" }),
    entry({ id: "c", text: "newest" }),
  ];
  let cursor = emptyPromptHistoryCursor();
  let current = { text: "draft", attachments: [] as AttachmentRef[] };
  for (const expected of ["newest", "mid", "oldest", "oldest"]) {
    const next = stepPromptHistory(items, current, cursor, "up");
    if (!next) {
      assert.equal(expected, "oldest");
      continue;
    }
    assert.equal(next.text, expected === "oldest" ? "oldest" : expected);
    cursor = next.cursor;
    current = { text: next.text, attachments: next.attachments };
  }
  const oldest = stepPromptHistory(items, current, cursor, "up");
  assert.equal(oldest, null);
});

test("cross-project and cross-worktree file refs are not portable; URLs are", () => {
  const file = {
    id: "a", name: "config.ts", mime: "text/plain", size: 4, kind: "file" as const,
    path: "src/config.ts", url: "/api/files/raw?projectId=pA&path=src%2Fconfig.ts",
  };
  const link = { id: "u", name: "docs", mime: "text/uri-list", size: 0, kind: "url" as const, url: "https://example.com" };
  const fromA = entry({ id: "e1", text: "use config", projectId: "pA", attachments: [file, link] });
  const intoB = attachmentsForRecall(fromA, { projectId: "pB" });
  assert.equal(intoB[0]!.path, undefined);
  assert.equal(intoB[0]!.url, undefined);
  assert.equal(isBlockedAttachment(intoB[0]!), true);
  assert.equal(intoB[1]!.url, "https://example.com");
  const sameProject = attachmentsForRecall(fromA, { projectId: "pA" });
  assert.equal(sameProject[0]!.path, "src/config.ts");
  const fromWt = entry({
    id: "e2", text: "wt", projectId: "pA", worktreePath: "/wt/a", attachments: [file],
  });
  const otherWt = attachmentsForRecall(fromWt, { projectId: "pA", worktreePath: "/wt/b" });
  assert.equal(otherWt[0]!.path, undefined);
  const sameWt = attachmentsForRecall(fromWt, { projectId: "pA", worktreePath: "/wt/a" });
  assert.equal(sameWt[0]!.path, "src/config.ts");
});

test("browser-context recall stays structured across projects and is not a blocked file", () => {
  const browserContext = {
    id: "ctx-page",
    type: "page" as const,
    browserSessionId: "b1",
    projectId: "pA",
    frameRevision: 1,
    url: "https://example.com/settings",
    title: "Example Domain",
    viewport: { width: 390, height: 844 },
    capturedAt: "2026-09-06T00:00:00.000Z",
    screenshot: { id: "shot-dead", mime: "image/jpeg", size: 12 },
  };
  const page = {
    id: "ctx-page",
    name: "Example Domain",
    mime: "application/vnd.polyth.browser-context+json",
    size: 12,
    kind: "browser-context" as const,
    url: "/api/browser/artifacts?id=shot-dead",
    browserContext,
  };
  const file = {
    id: "a", name: "config.ts", mime: "text/plain", size: 4, kind: "file" as const,
    path: "src/config.ts",
  };
  const fromA = entry({ id: "e-ctx", text: "use this page", projectId: "pA", attachments: [page, file] });
  const intoB = attachmentsForRecall(fromA, { projectId: "pB" });
  assert.equal(intoB[0]!.kind, "browser-context");
  assert.deepEqual(intoB[0]!.browserContext, browserContext);
  assert.equal(intoB[0]!.url, "/api/browser/artifacts?id=shot-dead");
  assert.equal(isBlockedAttachment(intoB[0]!), false);
  assert.equal(intoB[1]!.path, undefined);
  assert.equal(isBlockedAttachment(intoB[1]!), true);
  assert.equal(isBlockedAttachment({ ...page, browserContext: undefined }), true);
});

test("history keyboard handling yields to IME, autocomplete, queue edit, and modifiers", () => {
  assert.equal(shouldHandlePromptHistoryKey({ key: "ArrowUp", composing: true }), false);
  assert.equal(shouldHandlePromptHistoryKey({ key: "ArrowUp", composing: false, autocompleteActive: true }), false);
  assert.equal(shouldHandlePromptHistoryKey({ key: "ArrowUp", composing: false, queueEditActive: true }), false);
  assert.equal(shouldHandlePromptHistoryKey({ key: "ArrowUp", composing: false, shiftKey: true }), false);
  assert.equal(shouldHandlePromptHistoryKey({ key: "ArrowUp", composing: false, ctrlKey: true }), false);
  assert.equal(shouldHandlePromptHistoryKey({ key: "ArrowUp", composing: false, metaKey: true }), false);
  assert.equal(shouldHandlePromptHistoryKey({ key: "ArrowUp", composing: false, altKey: true }), false);
  assert.equal(shouldHandlePromptHistoryKey({ key: "ArrowUp", composing: false }), true);
  assert.equal(shouldHandlePromptHistoryKey({ key: "ArrowDown", composing: false }), true);
});

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  HTMLTextAreaElement: (dom as unknown as { HTMLTextAreaElement: typeof HTMLTextAreaElement }).HTMLTextAreaElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  KeyboardEvent: (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement, createRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const AdaptiveTextInput = (await import("../src/components/input/AdaptiveTextInput.tsx")).default;
const { usePromptHistory } = await import("../src/composer/usePromptHistory.ts");
type TextInputHandle = import("../src/components/input/AdaptiveTextInput.tsx").TextInputHandle;
type HistoryNav = ReturnType<typeof usePromptHistory>;
const KeyboardEventCtor = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("AdaptiveTextInput invokes history only when native ArrowUp/Down cannot move", async () => {
  const moved: string[] = [];
  const unmoved: string[] = [];
  const handle = createRef<TextInputHandle>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(AdaptiveTextInput, {
      ref: handle,
      initialText: "hello",
      onUnmovedArrow: (key: "ArrowUp" | "ArrowDown") => unmoved.push(key),
      onTextChange: (text: string) => moved.push(text),
    }));
  });
  const ta = container.querySelector("textarea");
  assert.ok(ta);
  ta.focus();
  ta.setSelectionRange(5, 5);
  ta.dispatchEvent(new KeyboardEventCtor("keydown", { key: "ArrowUp", bubbles: true }));
  await flush();
  assert.deepEqual(unmoved, ["ArrowUp"]);

  unmoved.length = 0;
  ta.setSelectionRange(2, 2);
  ta.dispatchEvent(new KeyboardEventCtor("keydown", { key: "ArrowUp", bubbles: true, shiftKey: true }));
  await flush();
  assert.deepEqual(unmoved, []);

  ta.dispatchEvent(new KeyboardEventCtor("keydown", { key: "ArrowDown", bubbles: true, ctrlKey: true }));
  await flush();
  assert.deepEqual(unmoved, []);

  handle.current?.replaceText("recalled", { anchor: 8 }, { silent: true });
  assert.equal(handle.current?.getText(), "recalled");
  assert.equal(moved.includes("recalled"), false);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("native caret movement suppresses history even on ArrowUp", async () => {
  const unmoved: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(AdaptiveTextInput, {
      initialText: "hello",
      onUnmovedArrow: (key: "ArrowUp" | "ArrowDown") => unmoved.push(key),
    }));
  });
  const ta = container.querySelector("textarea")!;
  ta.setSelectionRange(5, 5);
  ta.dispatchEvent(new KeyboardEventCtor("keydown", { key: "ArrowUp", bubbles: true }));
  ta.setSelectionRange(0, 0);
  await flush();
  assert.deepEqual(unmoved, [], "selection moved before the macrotask, so history stays idle");
  await act(async () => { root.unmount(); });
  container.remove();
});

test("autocomplete intercept consumes arrows before the unmoved-history path", async () => {
  const unmoved: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(AdaptiveTextInput, {
      initialText: "@",
      onKeyIntercept: (e: { key: string }) => e.key === "ArrowUp" || e.key === "ArrowDown",
      onUnmovedArrow: (key: "ArrowUp" | "ArrowDown") => unmoved.push(key),
    }));
  });
  const ta = container.querySelector("textarea")!;
  ta.dispatchEvent(new KeyboardEventCtor("keydown", { key: "ArrowUp", bubbles: true }));
  await flush();
  assert.deepEqual(unmoved, []);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("silent history replace does not cancel stacked unmoved-arrow timeouts", async () => {
  const unmoved: string[] = [];
  const handle = createRef<TextInputHandle>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(AdaptiveTextInput, {
      ref: handle,
      initialText: "hello",
      onUnmovedArrow: (key: "ArrowUp" | "ArrowDown") => {
        unmoved.push(key);
        handle.current?.replaceText("recalled", { anchor: 8 }, { silent: true });
      },
    }));
  });
  const ta = container.querySelector("textarea")!;
  ta.setSelectionRange(5, 5);
  ta.dispatchEvent(new KeyboardEventCtor("keydown", { key: "ArrowUp", bubbles: true }));
  ta.dispatchEvent(new KeyboardEventCtor("keydown", { key: "ArrowUp", bubbles: true }));
  await flush();
  assert.deepEqual(unmoved, ["ArrowUp", "ArrowUp"]);
  await act(async () => { root.unmount(); });
  container.remove();
});

function installHistoryFetch(handler?: (url: URL) => PromptHistoryEntryDto[] | Promise<PromptHistoryEntryDto[]>): () => void {
  const prev = globalThis.fetch;
  (globalThis as { fetch?: typeof fetch }).fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://127.0.0.1:4400/");
    const entries = handler
      ? await handler(url)
      : [entry({ id: `${url.searchParams.get("sessionId") ?? url.searchParams.get("scope")}-hist`, sessionId: url.searchParams.get("sessionId") ?? "space", text: `${url.searchParams.get("sessionId") ?? url.searchParams.get("scope")}-history` })];
    return {
      ok: true, status: 200,
      json: async () => ({ entries }),
      text: async () => "",
    } as Response;
  }) as typeof fetch;
  return () => {
    (globalThis as { fetch?: typeof fetch }).fetch = prev;
  };
}

async function waitForHistory(getItems: () => ReadonlyArray<{ text: string }> | undefined, text: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (getItems()?.some((item) => item.text === text)) return;
    await flush();
  }
  assert.fail(`history did not load ${text}`);
}

test("usePromptHistory fetch is keyed by session and ignores stale responses without per-arrow HTTP", async () => {
  const calls: string[] = [];
  const delayed = new Map<string, { entries: PromptHistoryEntryDto[]; resolve: () => void }>();
  const restore = installHistoryFetch((url) => {
    calls.push(url.search);
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const entries = [entry({ id: `${sessionId}-1`, sessionId, text: `${sessionId}-prompt` })];
    if (sessionId === "sess-a") {
      return new Promise((resolve) => {
        delayed.set(sessionId, { entries, resolve: () => resolve(entries) });
      });
    }
    return entries;
  });

  const box: { nav: HistoryNav | null } = { nav: null };
  function Probe(props: { sessionId: string }) {
    box.nav = usePromptHistory({
      sessionId: props.sessionId,
      projectId: "p1",
      scope: "session",
      limit: 40,
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(Probe, { sessionId: "sess-a" })); });
  await act(async () => { root.render(createElement(Probe, { sessionId: "sess-b" })); });
  await flush();
  assert.equal(box.nav?.items[0]?.text, "sess-b-prompt");
  delayed.get("sess-a")?.resolve();
  await flush();
  assert.equal(box.nav?.items[0]?.text, "sess-b-prompt");
  const fetches = calls.length;
  const displayed: string[] = [];
  for (let i = 0; i < 100; i++) {
    box.nav?.step({ text: displayed.at(-1) ?? "draft", attachments: [] }, i % 2 === 0 ? "up" : "down", (draft) => displayed.push(draft.text));
  }
  assert.equal(calls.length, fetches, "arrow navigation must not issue history HTTP");
  assert.equal(calls.some((c) => c.includes("filesStat") || c.includes("/files/")), false);
  assert.equal(box.nav?.isBrowsing(), false);
  assert.deepEqual(displayed.slice(0, 2), ["sess-b-prompt", "draft"]);

  await act(async () => { root.unmount(); });
  container.remove();
  restore();
});

test("session-scoped hero clears items and ignores a pending previous-session fetch", async () => {
  const delayed = new Map<string, { resolve: () => void }>();
  const restore = installHistoryFetch((url) => {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const entries = [entry({ id: `${sessionId}-1`, sessionId, text: `${sessionId}-prompt` })];
    return new Promise((resolve) => {
      delayed.set(sessionId, { resolve: () => resolve(entries) });
    });
  });

  const box: { nav: HistoryNav | null } = { nav: null };
  function Probe(props: { sessionId: string | null }) {
    box.nav = usePromptHistory({
      sessionId: props.sessionId,
      projectId: "p1",
      scope: "session",
      limit: 40,
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(Probe, { sessionId: "sess-a" })); });
  await act(async () => { root.render(createElement(Probe, { sessionId: null })); });
  await flush();
  assert.deepEqual(box.nav?.items ?? ["missing"], []);
  delayed.get("sess-a")?.resolve();
  await flush();
  assert.deepEqual(box.nav?.items ?? ["missing"], []);
  assert.equal(box.nav?.step({ text: "draft", attachments: [] }, "up", () => {}), false);

  await act(async () => { root.unmount(); });
  container.remove();
  restore();
});

test("late scope and limit responses never replace the current query", async () => {
  const delayed = new Map<string, { resolve: () => void }>();
  const restore = installHistoryFetch((url) => {
    const key = `${url.searchParams.get("scope")}:${url.searchParams.get("limit")}:${url.searchParams.get("sessionId") ?? ""}`;
    const entries = [entry({ id: key, text: key })];
    return new Promise((resolve) => {
      delayed.set(key, { resolve: () => resolve(entries) });
    });
  });
  const box: { nav: HistoryNav | null } = { nav: null };
  function Probe(props: { sessionId: string; scope: "session" | "space"; limit: number; projectId: string }) {
    box.nav = usePromptHistory(props);
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe, { sessionId: "s1", scope: "session", limit: 40, projectId: "p1" }));
  });
  await act(async () => {
    root.render(createElement(Probe, { sessionId: "s1", scope: "space", limit: 12, projectId: "p1" }));
  });
  delayed.get("session:40:s1")?.resolve();
  await flush();
  assert.deepEqual((box.nav?.items ?? []).map((item) => item.text), []);
  delayed.get("space:12:")?.resolve();
  await waitForHistory(() => box.nav?.items, "space:12:");
  assert.deepEqual((box.nav?.items ?? []).map((item) => item.text), ["space:12:"]);

  await act(async () => { root.unmount(); });
  container.remove();
  restore();
});

test("space-wide history does not refetch when only the session changes", async () => {
  const calls: string[] = [];
  const restore = installHistoryFetch((url) => {
    calls.push(url.search);
    return [entry({ id: "space-1", text: "space-history" })];
  });
  const box: { nav: HistoryNav | null } = { nav: null };
  function Probe(props: { sessionId: string }) {
    box.nav = usePromptHistory({
      sessionId: props.sessionId,
      projectId: "p1",
      scope: "space",
      limit: 40,
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(Probe, { sessionId: "sess-a" })); });
  await waitForHistory(() => box.nav?.items, "space-history");
  const fetches = calls.length;
  await act(async () => { root.render(createElement(Probe, { sessionId: "sess-b" })); });
  await flush();
  assert.equal(calls.length, fetches);
  assert.equal(box.nav?.items[0]?.text, "space-history");

  await act(async () => { root.unmount(); });
  container.remove();
  restore();
});

test("usePromptHistory keeps the browse snapshot across session and query changes until Composer resets", async () => {
  const restore = installHistoryFetch();
  const box: { nav: HistoryNav | null } = { nav: null };
  function Probe(props: { sessionId: string; limit: number; scope: "session" | "space" }) {
    box.nav = usePromptHistory({
      sessionId: props.sessionId,
      projectId: "p1",
      scope: props.scope,
      limit: props.limit,
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe, { sessionId: "sess-a", limit: 40, scope: "session" }));
  });
  await waitForHistory(() => box.nav?.items, "sess-a-history");
  box.nav?.step({ text: "unsent-a", attachments: [] }, "up", () => {});
  await flush();
  assert.equal(box.nav?.isBrowsing(), true);
  assert.equal(box.nav?.snapshot()?.text, "unsent-a");
  assert.deepEqual(box.nav?.displayedAttachments, []);

  await act(async () => {
    root.render(createElement(Probe, { sessionId: "sess-b", limit: 40, scope: "session" }));
  });
  await flush();
  assert.equal(box.nav?.isBrowsing(), true, "hook must not end browse before Composer flushes");
  assert.equal(box.nav?.snapshot()?.text, "unsent-a");

  const restored: string[] = [];
  box.nav?.cancelToDraft((draft) => restored.push(draft.text));
  await flush();
  assert.deepEqual(restored, ["unsent-a"]);
  assert.equal(box.nav?.isBrowsing(), false);
  assert.equal(box.nav?.displayedAttachments, null);

  await act(async () => { root.unmount(); });
  container.remove();
  restore();
});

test("takeDisplayedForSend returns recalled attachments and ends browse without touching the draft store", async () => {
  const file = {
    id: "a", name: "old.log", mime: "text/plain", size: 4, kind: "file" as const, path: "old.log",
  };
  const restore = installHistoryFetch(() => [
    entry({ id: "h1", text: "old prompt", attachments: [file] }),
  ]);
  const box: { nav: HistoryNav | null } = { nav: null };
  function Probe() {
    box.nav = usePromptHistory({
      sessionId: "sess-a",
      projectId: "p1",
      scope: "session",
      limit: 40,
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(Probe)); });
  await waitForHistory(() => box.nav?.items, "old prompt");
  assert.equal(box.nav?.takeDisplayedForSend(), null);
  box.nav?.step({ text: "draft", attachments: [] }, "up", () => {});
  const taken = box.nav?.takeDisplayedForSend();
  assert.equal(taken?.[0]?.path, "old.log");
  assert.equal(box.nav?.isBrowsing(), false);
  assert.equal(box.nav?.displayedAttachments, null);

  await act(async () => { root.unmount(); });
  container.remove();
  restore();
});
