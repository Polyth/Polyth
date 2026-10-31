import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage as unknown as Storage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.matchMedia = () => ({
  matches: false, media: "", onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent() { return false; },
});
globalThis.fetch = async () => new Response("{}", { status: 404 });

const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Composer } = await import("../src/components/Composer.tsx");
const { api } = await import("@polyth/session/web-api");
const { activateProject, activateSession, applyEvent, applyProjectRemoved, applyProjectUpsert, endPendingSend, getState, seedSessionCache, setModels, startNewSession, useStore } = await import("../src/store.ts");
const { loadScopedDraftRecord, trackOutboundDraftWrite } = await import("../src/draftRecord.ts");
const { clientPersistenceScope } = await import("../src/reliabilityContext.ts");
const { cancelDraftSync } = await import("../src/utils.ts");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

async function withComposer(
  name: string,
  rejected: boolean,
  run: (fixture: {
    input: HTMLTextAreaElement;
    send: () => Promise<void>;
    settleSend: () => Promise<void>;
    landPrompt: () => void;
    projectDraft: () => void;
    remount: () => Promise<void>;
    sessionId: string;
    creationTarget: () => "ordinary" | "isolated" | null;
  }) => Promise<void>,
  firstSend = false,
  isolatedSeed = false,
) {
  const originalSend = api.sendMessage;
  const originalSaveDraft = api.saveDraft;
  const originalCreate = api.createSession;
  const originalCreateIsolated = api.createIsolatedSession;
  const originalWorktrees = api.listWorktrees;
  const originalBranches = api.gitBranches;
  const originalEvents = api.getEvents;
  const originalList = api.listSessions;
  const originalSetTimeout = globalThis.setTimeout;
  const originalError = console.error;
  const started = deferred();
  const release = deferred();
  const sessionId = `composer-send-${name}`;
  const projectId = `composer-send-project-${name}`;
  const projection = {
    id: sessionId, projectId, title: "Chat", status: "idle" as const,
    createdAt: 1, updatedAt: 1, draft: "", draftUpdatedAt: 1,
  };
  const sentText = "submitted prompt";
  const calls: string[] = [];
  let creationTarget: "ordinary" | "isolated" | null = null;

  // Hold the local/server autosave timers so the send and projection order is
  // deterministic and no wall-clock delay can consume the pending input edit.
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 250 || delay === 2_500) return originalSetTimeout(() => {}, 0);
    return originalSetTimeout(callback, delay, ...args);
  }) as unknown as typeof setTimeout;
  api.sendMessage = (async (_id, body) => {
    calls.push(body.text);
    started.resolve();
    await release.promise;
    if (rejected) throw Object.assign(new Error("Rejected prompt"), { status: 400 });
    return { turnId: "turn-1" };
  }) as typeof api.sendMessage;
  api.saveDraft = (async () => ({ draftUpdatedAt: 3 })) as typeof api.saveDraft;
  if (firstSend) {
    api.createSession = (async () => { creationTarget = "ordinary"; return { id: sessionId }; }) as typeof api.createSession;
    api.createIsolatedSession = (async () => { creationTarget = "isolated"; return { id: sessionId }; }) as typeof api.createIsolatedSession;
    api.getEvents = (async () => []) as typeof api.getEvents;
    api.listSessions = (async () => [projection]) as typeof api.listSessions;
    if (isolatedSeed) {
      // No origin has loaded yet. An isolation seed must still reach the
      // canonical isolated boundary, never create an ordinary session.
      api.listWorktrees = async () => [];
      api.gitBranches = async () => ({ current: "", branches: [] });
    }
  }
  if (rejected) console.error = () => {};

  // Isolation is opt-in per project: only an enabled project offers it.
  if (isolatedSeed) {
    applyProjectUpsert({ id: projectId, name: "Isolated", path: `/tmp/${projectId}`, createdAt: 1, defaults: { isolation: "workspace" } });
  }
  activateProject(projectId);
  setModels([{ providerID: "test", modelID: "model", name: "Test model", connected: true }]);
  if (firstSend) startNewSession(projectId, { draft: "", ...(isolatedSeed ? { isolate: true } : {}) });
  else {
    seedSessionCache(projection);
    activateSession(sessionId);
  }
  const settleOutbound = trackOutboundDraftWrite(sessionId, sentText, clientPersistenceScope({ sessionId }));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  // A slow open shows the loading layer and mounts the composer again.
  let remountComposer: () => void = () => {};
  function FirstSendSurface() {
    const activeSessionId = useStore((state) => state.activeSessionId);
    const [generation, setGeneration] = useState(0);
    remountComposer = () => setGeneration((value) => value + 1);
    return createElement(Composer, { key: `${activeSessionId ?? "hero"}:${generation}` });
  }
  try {
    await act(async () => { root.render(createElement(firstSend ? FirstSendSurface : Composer)); });
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
    const button = host.querySelector<HTMLButtonElement>("button.send");
    assert.ok(input);
    assert.ok(button);
    await act(async () => {
      input.value = sentText;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await run({
      get input() { return host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]")!; },
      sessionId,
      creationTarget: () => creationTarget,
      remount: async () => { await act(async () => { remountComposer(); }); },
      send: async () => {
        await act(async () => { button.click(); await started.promise; });
        assert.deepEqual(calls, [sentText]);
        assert.equal(input.value, "", "the prompt leaves the input immediately");
        assert.equal(loadScopedDraftRecord(sessionId).text, sentText, "pending admission retains the recovery copy");
      },
      settleSend: async () => {
        await act(async () => {
          release.resolve();
          await new Promise<void>((resolve) => setImmediate(resolve));
        });
      },
      landPrompt: () => applyEvent({
        id: `test-prompt-${sessionId}`, sessionId, seq: 1, time: 2, v: 1,
        type: "user/message", data: { text: sentText },
      }),
      // A previous autosave was already in flight when Send cancelled its
      // timer. Its own projection can arrive before or after POST completes.
      projectDraft: () => seedSessionCache({ ...projection, draft: sentText, draftUpdatedAt: 2 }),
    });
  } finally {
    release.resolve();
    settleOutbound(true);
    await act(async () => { root.unmount(); });
    host.remove();
    for (const pending of getState().pendingSends) {
      if (pending.sessionId === sessionId) endPendingSend(pending.id);
    }
    cancelDraftSync(sessionId);
    api.sendMessage = originalSend;
    api.saveDraft = originalSaveDraft;
    api.createSession = originalCreate;
    api.createIsolatedSession = originalCreateIsolated;
    api.listWorktrees = originalWorktrees;
    api.gitBranches = originalBranches;
    api.getEvents = originalEvents;
    api.listSessions = originalList;
    if (isolatedSeed) applyProjectRemoved(projectId);
    globalThis.setTimeout = originalSetTimeout;
    console.error = originalError;
  }
}

test("an isolation seed waits for send and cannot fall back to ordinary creation before an origin loads", async () => {
  await withComposer("isolated-seed", false, async (fixture) => {
    assert.equal(fixture.creationTarget(), null, "mounting a draft creates no workspace or session");
    await fixture.send();
    assert.equal(fixture.creationTarget(), "isolated");
    await act(async () => { fixture.landPrompt(); });
    await fixture.settleSend();
  }, true, true);
});

test("the first-send remount stays empty when the canonical prompt precedes admission", async () => {
  await withComposer("first-send", false, async (fixture) => {
    const heroInput = fixture.input;
    await fixture.send();
    assert.notEqual(fixture.input, heroInput, "session creation mounted a fresh timeline Composer");
    await act(async () => { fixture.projectDraft(); fixture.landPrompt(); });
    assert.equal(fixture.input.value, "", "the recovery draft must stay out of the new input");
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    assert.equal(loadScopedDraftRecord(fixture.sessionId).text, "submitted prompt", "lifecycle persistence must retain the recovery copy during first-send admission");
    await fixture.settleSend();
    assert.equal(fixture.input.value, "");
    assert.equal(loadScopedDraftRecord(fixture.sessionId).text, "");
  }, true);
});

for (const rejected of [false, true]) {
  test(`a composer remounted before first-send admission ${rejected ? "gets a rejected prompt back" : "stays empty"}`, async () => {
    await withComposer(`first-send-remount-${rejected}`, rejected, async (fixture) => {
      await fixture.send();
      // The canonical prompt retires the echo while admission is still open,
      // then the transcript surface mounts a fresh composer.
      await act(async () => { fixture.landPrompt(); });
      await fixture.remount();
      assert.equal(fixture.input.value, "", "the staged recovery copy stays out of the remounted input");
      assert.equal(loadScopedDraftRecord(fixture.sessionId).text, "submitted prompt", "admission still owns the recovery copy");
      await fixture.settleSend();
      if (rejected) {
        assert.equal(fixture.input.value, "submitted prompt", "the rejected prompt returns to the composer now showing the chat");
        assert.equal(loadScopedDraftRecord(fixture.sessionId).text, "submitted prompt");
      } else {
        assert.equal(fixture.input.value, "");
        assert.equal(loadScopedDraftRecord(fixture.sessionId).text, "", "the admitted prompt is consumed");
        await fixture.remount();
        assert.equal(fixture.input.value, "", "a later mount has nothing to restore");
      }
    }, true);
  });
}

for (const responseFirst of [false, true]) {
  test(`sent draft stays cleared when the canonical prompt arrives ${responseFirst ? "after" : "before"} the send response`, async () => {
    await withComposer(`response-${responseFirst}`, false, async ({ input, send, settleSend, landPrompt, projectDraft, sessionId }) => {
      await send();
      if (responseFirst) await settleSend();
      await act(async () => { projectDraft(); landPrompt(); });
      assert.equal(input.value, "", "a projection must not reinsert submitted text");
      if (!responseFirst) await settleSend();
      assert.equal(input.value, "");
      const record = loadScopedDraftRecord(sessionId);
      assert.equal(record.text, "", "the submitted draft must also stay consumed in persistence");
      assert.equal(record.conflict, undefined, "an own autosave echo is not a remote conflict");
    });
  });
}

test("typing during pending admission survives a late autosave projection", async () => {
  await withComposer("newer-edit", false, async ({ input, send, settleSend, landPrompt, projectDraft, sessionId }) => {
    await send();
    await act(async () => {
      input.value = "next prompt";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      projectDraft();
      landPrompt();
    });
    assert.equal(input.value, "next prompt");
    await settleSend();
    assert.equal(input.value, "next prompt");
    assert.equal(loadScopedDraftRecord(sessionId).text, "next prompt");
  });
});

for (const newerEdit of [false, true]) {
  test(`rejected send ${newerEdit ? "preserves newer typing" : "restores the submitted draft"}`, async () => {
    await withComposer(`rejected-${newerEdit}`, true, async ({ input, send, settleSend, sessionId }) => {
      await send();
      if (newerEdit) await act(async () => {
        input.value = "next prompt";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settleSend();
      const expected = newerEdit ? "next prompt" : "submitted prompt";
      assert.equal(input.value, expected);
      // Admission has settled, so blur must flush the live input even though
      // this fixture still holds the 250ms local persistence timer.
      await act(async () => { input.dispatchEvent(new Event("focusout", { bubbles: true })); });
      assert.equal(loadScopedDraftRecord(sessionId).text, expected);
      assert.equal(getState().pendingSends.some((item) => item.sessionId === sessionId), false);
    });
  });
}

for (const elsewhere of ["session", "project"] as const) {
  test(`a first send finishes in the background after the user moves to another ${elsewhere}`, async () => {
    const originalSend = api.sendMessage;
    const originalCreate = api.createSession;
    const originalEvents = api.getEvents;
    const originalList = api.listSessions;
    const projectId = `first-send-away-${elsewhere}`;
    const otherProjectId = elsewhere === "project" ? `${projectId}-other` : projectId;
    const createdId = `${projectId}-created`;
    const otherId = `${projectId}-elsewhere`;
    const creating = deferred();
    const sent: Array<{ id: string; text: string }> = [];
    api.createSession = (async () => { await creating.promise; return { id: createdId }; }) as typeof api.createSession;
    api.sendMessage = (async (id, body) => { sent.push({ id, text: body.text }); return { turnId: "turn-1" }; }) as typeof api.sendMessage;
    api.getEvents = (async () => []) as typeof api.getEvents;
    api.listSessions = (async () => []) as typeof api.listSessions;
    activateProject(projectId);
    setModels([{ providerID: "test", modelID: "model", name: "Test model", connected: true }]);
    startNewSession(projectId, { draft: "" });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    function Surface() {
      const activeSessionId = useStore((state) => state.activeSessionId);
      return createElement(Composer, { key: activeSessionId ?? "hero" });
    }
    try {
      await act(async () => { root.render(createElement(Surface)); });
      const input = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]")!;
      await act(async () => {
        input.value = "keep going without me";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => { host.querySelector<HTMLButtonElement>("button.send")!.click(); });
      // Navigate away while the create request is still in flight.
      await act(async () => {
        if (otherProjectId !== projectId) activateProject(otherProjectId);
        seedSessionCache({ id: otherId, projectId: otherProjectId, title: "Other", status: "idle", createdAt: 1, updatedAt: 1 });
        activateSession(otherId);
      });
      await act(async () => {
        creating.resolve();
        for (let i = 0; i < 20 && sent.length === 0; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
      });
      assert.deepEqual(sent, [{ id: createdId, text: "keep going without me" }], "the created session receives its first prompt");
      assert.equal(getState().activeSessionId, otherId, "creation must not pull the user back");
      assert.equal(getState().activeProjectId, otherProjectId);
      assert.ok(getState().sessions.some((session) => session.id === createdId), "the new chat is listed");
      const otherInput = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]")!;
      await act(async () => {
        otherInput.value = "a message here";
        otherInput.dispatchEvent(new Event("input", { bubbles: true }));
      });
      assert.equal(host.querySelector<HTMLButtonElement>("button.send")!.disabled, false, "the other chat stays sendable");
    } finally {
      creating.resolve();
      await act(async () => { root.unmount(); });
      host.remove();
      for (const pending of getState().pendingSends) {
        if (pending.sessionId === createdId || pending.sessionId === null) endPendingSend(pending.id);
      }
      cancelDraftSync(createdId);
      cancelDraftSync(otherId);
      api.sendMessage = originalSend;
      api.createSession = originalCreate;
      api.getEvents = originalEvents;
      api.listSessions = originalList;
    }
  });
}
