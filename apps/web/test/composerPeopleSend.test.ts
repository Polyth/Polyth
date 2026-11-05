// Mounted people-mode send: picking a person from the @ picker sends through
// POST /person-messages and never through the agent message route. Assertions
// compare strings/booleans only.
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

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Composer } = await import("../src/components/Composer.tsx");
const { api } = await import("@polyth/session/web-api");
const { activateProject, activateSession, getState, seedSessionCache, setModels, startNewSession } = await import("../src/store.ts");
const { forgetMentionCandidates } = await import("../src/sessionPeople.ts");
const { tr } = await import("../src/i18n/index.ts");
const { pendingAttachments, seedAttachments } = await import("../src/attachments.ts");
const { loadDraft } = await import("../src/utils.ts");

test("picking a person sends a person message and never an agent turn", async () => {
  const projectId = "people-project";
  const sessionId = "people-session";
  const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
  const originalFetch = globalThis.fetch;
  const originalSendMessage = api.sendMessage;
  const originalSaveDraft = api.saveDraft;
  const agentSends: string[] = [];
  api.sendMessage = (async (_id, body) => { agentSends.push(body.text); return { turnId: "t" }; }) as typeof api.sendMessage;
  api.saveDraft = (async () => ({ draftUpdatedAt: 2 })) as typeof api.saveDraft;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ url, method, body });
    if (url.includes("/mention-candidates")) {
      return new Response(JSON.stringify({ items: [{ userId: "u-alice", name: "Alice", access: "collaborate" }] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/person-messages")) {
      return new Response(JSON.stringify({ seq: 9, mentions: ["u-alice"] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/queue")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/files/search")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  activateProject(projectId);
  setModels([{ providerID: "test", modelID: "model", name: "Test model", connected: true }]);
  seedSessionCache({
    id: sessionId, projectId, title: "People chat", status: "idle" as const,
    createdAt: 1, updatedAt: 1, draft: "", draftUpdatedAt: 1,
    sharing: { access: "collaborate", shared: true } as never,
  });
  activateSession(sessionId);
  // A screenshot picked before the mention must leave with the message.
  seedAttachments(sessionId, [{
    id: "att-screenshot", name: "screen.png", mime: "image/png", size: 2048,
    kind: "url", url: "https://example.com/screen.png",
  }]);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(Composer)); });
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
    assert.ok(input);
    await act(async () => {
      input.value = "@";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const personOption = await (async () => {
      for (let i = 0; i < 20 && !host.querySelector('.ac-item[data-kind="person"]'); i += 1) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
      }
      return host.querySelector<HTMLElement>('.ac-item[data-kind="person"]');
    })();
    assert.ok(personOption, "the People group renders for the @ token");
    await act(async () => {
      personOption.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    const send = host.querySelector<HTMLButtonElement>("button.composer-people-send");
    assert.ok(send, "the composer switches to people mode and shows the people send button");
    await act(async () => {
      send.click();
      await new Promise((resolve) => setImmediate(resolve));
    });
    const personPosts = requests.filter((request) => request.url.includes("/person-messages"));
    assert.equal(personPosts.length, 1, "exactly one person-messages POST");
    assert.match(personPosts[0]!.body ?? "", /u-alice/);
    const posted = JSON.parse(personPosts[0]!.body ?? "{}") as { attachments?: Array<{ name: string }> };
    assert.equal(posted.attachments?.length, 1, "the screenshot travels with the message");
    assert.equal(posted.attachments?.[0]?.name, "screen.png");
    assert.equal(pendingAttachments(sessionId).length, 0, "sent pills leave the composer");
    assert.equal(host.querySelectorAll(".attachment-pill").length, 0);
    assert.deepEqual(agentSends, [], "no agent message was sent");
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = originalFetch;
    api.sendMessage = originalSendMessage;
    api.saveDraft = originalSaveDraft;
  }
});

interface FlowOptions {
  access?: "manage" | "collaborate" | "view";
  action?: "share" | "request" | "none";
  levels?: string[];
  approver?: { userId: string; name: string };
  /** The message's response waits for this, as a slow network would. */
  postHeld?: Promise<void>;
  postStatus?: number;
}

/** One composer with a mention of Bob, who cannot open the chat. */
async function mentionFlow(sessionId: string, options: FlowOptions, run: (flow: {
  host: HTMLElement;
  posts(): Array<Record<string, unknown>>;
  agentSends: string[];
  line(): string;
  click(selector: string): Promise<void>;
  send(): Promise<void>;
  /** What the first event of an empty chat does: another Composer takes over in one commit. */
  swapComposer(): Promise<void>;
  settle(): Promise<void>;
  input(): HTMLTextAreaElement;
}) => Promise<void>): Promise<void> {
  const projectId = "people-project";
  const requests: Array<{ url: string; body: string | undefined }> = [];
  const originalFetch = globalThis.fetch;
  const originalSendMessage = api.sendMessage;
  const originalSaveDraft = api.saveDraft;
  const agentSends: string[] = [];
  api.sendMessage = (async (_id, body) => { agentSends.push(body.text); return { turnId: "t" }; }) as typeof api.sendMessage;
  api.saveDraft = (async () => ({ draftUpdatedAt: 2 })) as typeof api.saveDraft;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("/person-messages")) {
      await options.postHeld;
      if (options.postStatus) return new Response("{}", { status: options.postStatus, headers: { "Content-Type": "application/json" } });
    }
    const reply = url.includes("/sharing/outsiders")
      ? { people: [{ userId: "u-bob", name: "Bob Stone" }], action: options.action ?? "share", levels: options.levels ?? ["view", "collaborate", "manage"], ...(options.approver ? { approver: options.approver } : {}) }
      : url.includes("/mention-candidates") ? { items: [] }
        : url.includes("/person-messages") ? { seq: 9, mentions: [] }
          : url.includes("/queue") || url.includes("/api/files/search") ? [] : {};
    return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  activateProject(projectId);
  seedSessionCache({
    id: sessionId, projectId, title: "Chat", status: "idle" as const,
    createdAt: 1, updatedAt: 1, draft: "", draftUpdatedAt: 1,
    sharing: { visibility: "private", access: options.access ?? "manage", shared: false } as never,
  });
  activateSession(sessionId);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3)); });
  };
  try {
    await act(async () => { root.render(createElement(Composer)); });
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
    assert.ok(input);
    await act(async () => {
      input.value = "@";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (let i = 0; i < 20 && !host.querySelector('.ac-item[data-kind="person"]'); i += 1) await settle();
    const group = host.querySelector(".ac-group-label");
    assert.equal(group?.textContent, tr("composer.people.outsideGroup"), "the rest of the Space has its own heading");
    assert.equal(host.querySelector(".ac-header") === null, true, "no Files title over people");
    await act(async () => {
      host.querySelector('.ac-item[data-kind="person"]')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await run({
      host,
      agentSends,
      posts: () => requests.filter((request) => request.url.includes("/person-messages")).map((request) => JSON.parse(request.body ?? "{}")),
      line: () => host.querySelector(".mention-access-text")?.textContent ?? "",
      click: async (selector) => {
        const element = host.querySelector<HTMLElement>(selector);
        assert.ok(element !== null, `no ${selector}`);
        await act(async () => { element.click(); await new Promise((resolve) => setImmediate(resolve)); });
      },
      send: async () => {
        await act(async () => {
          host.querySelector<HTMLButtonElement>("button.composer-people-send")!.click();
          await new Promise((resolve) => setImmediate(resolve));
        });
        await settle();
      },
      swapComposer: async () => {
        await act(async () => { root.render(createElement("div", null, createElement(Composer))); });
      },
      settle,
      input: () => host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]")!,
    });
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = originalFetch;
    api.sendMessage = originalSendMessage;
    api.saveDraft = originalSaveDraft;
    forgetMentionCandidates(sessionId);
  }
}

test("a send never opens a chat by itself: it waits for the answer, then shares with the message", async () => {
  await mentionFlow("share-flow", {}, async (flow) => {
    assert.equal(flow.line(), tr("composer.people.access.askOne", { names: "Bob" }));
    assert.equal(flow.host.querySelector("button.composer-people-send")?.getAttribute("aria-label"), tr("composer.people.sendToOne", { name: "Bob" }));

    await flow.send();
    assert.equal(flow.posts().length, 0, "the send waits for an answer");
    assert.equal(flow.host.querySelector(".mention-access")?.hasAttribute("data-attention"), true);

    await flow.click(".mention-access-action.is-primary");
    assert.equal(flow.line(), tr("composer.people.access.grantedOne", { names: "Bob" }));
    assert.equal(flow.posts().length, 0, "answering sends nothing and opens nothing");

    await flow.send();
    assert.equal(flow.posts().length, 1);
    assert.deepEqual(flow.posts()[0]!.mentions, ["u-bob"]);
    assert.deepEqual(flow.posts()[0]!.shareWith, [{ userId: "u-bob", access: "view" }]);
    assert.equal(flow.posts()[0]!.requestAccessFor, undefined);
    assert.deepEqual(flow.agentSends, []);
    assert.equal(flow.host.querySelector(".mention-access") === null, true, "the line leaves with the message");
  });
});

test("declining leaves plain words: still a message to people, nobody named, nothing opened", async () => {
  await mentionFlow("skip-flow", {}, async (flow) => {
    await flow.click(".mention-access-dismiss");
    assert.equal(flow.host.querySelector(".mention-access") === null, true);
    assert.equal(flow.host.querySelector("button.composer-people-send")?.getAttribute("aria-label"), tr("conversation.send"));
    await flow.send();
    assert.equal(flow.posts().length, 1);
    assert.equal(flow.posts()[0]!.mentions, undefined);
    assert.equal(flow.posts()[0]!.shareWith, undefined);
    assert.deepEqual(flow.agentSends, [], "an answer never turns the message into a prompt");
  });
});

test("the first message of an empty chat: the composer that takes over opens empty", async () => {
  let release = (): void => undefined;
  const postHeld = new Promise<void>((resolve) => { release = resolve; });
  const sessionId = "swap-flow";
  await mentionFlow(sessionId, { postHeld }, async (flow) => {
    await flow.click(".mention-access-action.is-primary");
    seedAttachments(sessionId, [{ id: "att-a", name: "a.png", mime: "image/png", size: 1, kind: "url", url: "https://example.com/a.png" }]);
    await flow.settle();
    const sent = flow.input().value.trim();
    assert.ok(sent);
    // Past the local autosave, as anyone who pauses before sending is.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    assert.equal(loadDraft(sessionId).trim(), sent);
    await flow.send();
    assert.equal(flow.posts().length, 1);
    assert.equal(loadDraft(sessionId), "", "the send owns the words while they travel");
    assert.equal(flow.input().value.trim(), sent, "they stay on screen until the answer");
    await act(async () => {
      flow.input().focus();
      flow.input().blur();
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    assert.equal(loadDraft(sessionId), "", "neither a blur nor the autosave writes them back");

    await flow.swapComposer();
    assert.equal(flow.input().value, "", "the event came first, and the words do not come back");
    assert.equal(loadDraft(sessionId), "", "the leaving composer did not write them back");
    assert.equal(pendingAttachments(sessionId).length, 1, "the pills are not yet known to have travelled");

    release();
    await flow.settle();
    assert.equal(flow.input().value, "");
    assert.equal(loadDraft(sessionId), "");
    assert.equal(pendingAttachments(sessionId).length, 0, "the answer clears the pills in the new composer too");
  });
});

test("a send right after typing outruns the autosave that was still waiting", async () => {
  const sessionId = "quick-flow";
  let release = (): void => undefined;
  const postHeld = new Promise<void>((resolve) => { release = resolve; });
  await mentionFlow(sessionId, { postHeld }, async (flow) => {
    await flow.click(".mention-access-action.is-primary");
    await flow.send();
    assert.equal(flow.posts().length, 1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    assert.equal(loadDraft(sessionId), "");
    release();
    await flow.settle();
  });
});

test("a message that fails gives its words back to the draft", async () => {
  const sessionId = "fail-flow";
  await mentionFlow(sessionId, { postStatus: 500 }, async (flow) => {
    await flow.click(".mention-access-action.is-primary");
    const sent = flow.input().value.trim();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    await flow.send();
    assert.equal(flow.posts().length, 1);
    assert.equal(flow.input().value.trim(), sent, "the words stay to be sent again");
    assert.equal(loadDraft(sessionId), sent);
  });
});

test("the writer stays in the input when the composer is replaced, on a mouse screen only", async () => {
  const windowWithQuery = dom as unknown as { matchMedia(query: string): { matches: boolean } };
  const originalMatchMedia = windowWithQuery.matchMedia;
  for (const fine of [true, false]) {
    windowWithQuery.matchMedia = () => ({ matches: fine });
    try {
      await mentionFlow(`focus-flow-${fine}`, {}, async (flow) => {
        await act(async () => { flow.input().focus(); });
        assert.equal(document.activeElement, flow.input());
        await flow.swapComposer();
        assert.equal(document.activeElement === flow.input(), fine);
      });
    } finally {
      windowWithQuery.matchMedia = originalMatchMedia;
    }
  }
});

test("undo puts the question back", async () => {
  await mentionFlow("undo-flow", {}, async (flow) => {
    await flow.click(".mention-access-action.is-primary");
    await flow.click(".mention-access-dismiss");
    assert.equal(flow.line(), tr("composer.people.access.askOne", { names: "Bob" }));
    await flow.send();
    assert.equal(flow.posts().length, 0);
  });
});

test("addressing the agent drops the question: nobody will be told", async () => {
  await mentionFlow("agent-flow", {}, async (flow) => {
    await flow.click('.composer-people-toggle button[aria-checked="false"]');
    assert.equal(flow.host.querySelector(".mention-access") === null, true);
    assert.equal(flow.host.querySelector("button.composer-people-send") === null, true);
  });
});

test("someone who cannot share asks the owner instead", async () => {
  await mentionFlow("request-flow", { access: "collaborate", action: "request", levels: [], approver: { userId: "u-ann", name: "Ann Lee" } }, async (flow) => {
    assert.equal(flow.line(), tr("composer.people.access.requestOne", { names: "Bob", name: "Ann" }));
    await flow.send();
    assert.equal(flow.posts().length, 0, "a request waits for the answer too");
    await flow.click(".mention-access-action.is-primary");
    assert.equal(flow.line(), tr("composer.people.access.requested", { name: "Ann" }));
    assert.equal(flow.host.querySelector(".mention-access-level") === null, true, "the approver picks the level");
    await flow.send();
    assert.deepEqual(flow.posts()[0]!.requestAccessFor, ["u-bob"]);
    assert.equal(flow.posts()[0]!.shareWith, undefined);
    assert.deepEqual(flow.posts()[0]!.mentions, ["u-bob"]);
  });
});

test("with nobody able to share the line only says so, and the message still goes", async () => {
  await mentionFlow("none-flow", { access: "collaborate", action: "none", levels: [] }, async (flow) => {
    assert.equal(flow.line(), tr("composer.people.access.blockedOne", { names: "Bob" }));
    assert.equal(flow.host.querySelector(".mention-access-action") === null, true);
    await flow.send();
    assert.equal(flow.posts().length, 1);
    assert.equal(flow.posts()[0]!.mentions, undefined);
  });
});

// Last in the file: each case opens a project of its own, and coming back to
// another project reloads its chats, which these stubs do not serve.
/** A new chat, no session yet, with a mention of Bob already picked. */
async function newChatFlow(name: string, options: {
  postHeld?: Promise<void>;
  createFails?: boolean;
  postStatus?: number;
  noModels?: boolean;
  action?: "share" | "none";
  inside?: boolean;
}, run: (flow: {
  host: HTMLElement;
  sessionId: string;
  creates: unknown[];
  agentSends: string[];
  posts(): Array<{ url: string; body: Record<string, unknown> }>;
  line(): string;
  input(): HTMLTextAreaElement;
  click(selector: string): Promise<void>;
  send(): Promise<void>;
  settle(): Promise<void>;
}) => Promise<void>): Promise<void> {
  const projectId = `new-chat-${name}`;
  const sessionId = `new-chat-session-${name}`;
  const requests: Array<{ url: string; body: string | undefined }> = [];
  const creates: unknown[] = [];
  const agentSends: string[] = [];
  const originalFetch = globalThis.fetch;
  const originals = { send: api.sendMessage, saveDraft: api.saveDraft, create: api.createSession, events: api.getEvents, list: api.listSessions };
  const originalError = console.error;
  console.error = () => {};
  api.sendMessage = (async (_id, body) => { agentSends.push(body.text); return { turnId: "t" }; }) as typeof api.sendMessage;
  api.saveDraft = (async () => ({ draftUpdatedAt: 2 })) as typeof api.saveDraft;
  api.getEvents = (async () => []) as typeof api.getEvents;
  api.listSessions = (async () => [{ id: sessionId, projectId, title: "", status: "idle" as const, createdAt: 1, updatedAt: 1 }]) as typeof api.listSessions;
  api.createSession = (async (input) => {
    creates.push(input);
    if (options.createFails) throw Object.assign(new Error("refused"), { status: 403 });
    return { id: sessionId };
  }) as typeof api.createSession;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("/person-messages")) await options.postHeld;
    if (url.includes("/person-messages") && options.postStatus) {
      return new Response("{}", { status: options.postStatus, headers: { "Content-Type": "application/json" } });
    }
    const bob = { userId: "u-bob", name: "Bob Stone" };
    const reply = url.includes("/api/sharing/new-chat")
      ? {
        people: options.inside ? [] : [bob],
        inside: options.inside ? [{ ...bob, access: "collaborate" }] : [],
        action: options.action ?? "share",
        levels: options.action === "none" ? [] : ["view", "collaborate", "manage"],
      }
      : url.includes("/sharing/outsiders") ? { people: [bob], action: "share", levels: ["view", "collaborate", "manage"] }
        : url.includes("/mention-candidates") ? { items: [] }
          : url.includes("/person-messages") ? { seq: 1, mentions: ["u-bob"] }
            : url.includes("/queue") || url.includes("/api/files/search") ? [] : null;
    // A 404 on the chat itself would read as its deletion; the rest of the shell
    // reads what it wants in the background, and nothing here serves it.
    if (reply === null) return url.includes(sessionId)
      ? new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
      : new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  activateProject(projectId);
  setModels(options.noModels ? [] : [{ providerID: "test", modelID: "model", name: "Test model", connected: true }]);
  startNewSession(projectId, { draft: "" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const settle = async () => {
    for (let i = 0; i < 12; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3)); });
  };
  const input = () => host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]")!;
  try {
    await act(async () => { root.render(createElement(Composer)); });
    await settle();
    assert.equal(getState().activeSessionId, null);
    await act(async () => {
      input().value = "@";
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (let i = 0; i < 20 && !host.querySelector('.ac-item[data-kind="person"]'); i += 1) await settle();
    await act(async () => {
      host.querySelector('.ac-item[data-kind="person"]')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await run({
      host,
      sessionId,
      creates,
      agentSends,
      posts: () => requests.filter((request) => request.url.includes("/person-messages"))
        .map((request) => ({ url: request.url, body: JSON.parse(request.body ?? "{}") as Record<string, unknown> })),
      line: () => host.querySelector(".mention-access-text")?.textContent ?? "",
      input,
      click: async (selector) => {
        const element = host.querySelector<HTMLElement>(selector);
        assert.ok(element !== null, `no ${selector}`);
        await act(async () => { element.click(); await new Promise((resolve) => setImmediate(resolve)); });
      },
      send: async () => {
        await act(async () => {
          host.querySelector<HTMLButtonElement>("button.composer-people-send")!.click();
          await new Promise((resolve) => setImmediate(resolve));
        });
        await settle();
      },
      settle,
    });
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = originalFetch;
    api.sendMessage = originals.send;
    api.saveDraft = originals.saveDraft;
    api.createSession = originals.create;
    api.getEvents = originals.events;
    api.listSessions = originals.list;
    console.error = originalError;
    forgetMentionCandidates(sessionId);
    activateSession(null);
  }
}

test("a new chat asks first, then makes the chat for the message, with no turn", async () => {
  await newChatFlow("share", { noModels: true }, async (flow) => {
    assert.equal(flow.line(), tr("composer.people.access.askOne", { names: "Bob" }));
    const sent = flow.input().value.trim();
    assert.ok(sent);

    await flow.send();
    assert.equal(flow.creates.length, 0, "an unanswered question makes no chat");
    assert.equal(flow.posts().length, 0);
    assert.equal(flow.host.querySelector(".mention-access")?.hasAttribute("data-attention"), true);

    await flow.click(".mention-access-action.is-primary");
    assert.equal(flow.creates.length, 0, "answering makes no chat either");
    await flow.send();

    assert.equal(flow.creates.length, 1, "with no model around, a message to people still goes");
    assert.equal(flow.posts().length, 1);
    assert.match(flow.posts()[0]!.url, new RegExp(`/api/sessions/${flow.sessionId}/person-messages`));
    assert.equal(flow.posts()[0]!.body.text, sent);
    assert.deepEqual(flow.posts()[0]!.body.mentions, ["u-bob"]);
    assert.deepEqual(flow.posts()[0]!.body.shareWith, [{ userId: "u-bob", access: "view" }]);
    assert.deepEqual(flow.agentSends, [], "no agent turn");
    assert.equal(getState().activeSessionId, flow.sessionId, "the chat opens once the message is in it");
    assert.equal(flow.input().value, "");
    assert.equal(loadDraft(flow.sessionId), "");
    assert.equal(flow.host.querySelector(".mention-access"), null);
  });
});

test("while a new chat's message travels its words stay, and a second Send makes no second chat", async () => {
  let release = (): void => undefined;
  const postHeld = new Promise<void>((resolve) => { release = resolve; });
  await newChatFlow("held", { postHeld }, async (flow) => {
    await flow.click(".mention-access-action.is-primary");
    const sent = flow.input().value.trim();
    await flow.send();
    assert.equal(flow.creates.length, 1);
    assert.equal(flow.input().value.trim(), sent, "no echo carries them, so they stay on screen");
    assert.equal(getState().activeSessionId, null, "the chat opens with the message in it");
    const button = flow.host.querySelector<HTMLButtonElement>("button.composer-people-send");
    assert.equal(button?.disabled, true);
    assert.equal(button?.getAttribute("aria-busy"), "true");
    assert.equal(button?.getAttribute("aria-label"), tr("conversation.creating"), "the wait says what it is");
    await act(async () => {
      flow.input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await new Promise((resolve) => setImmediate(resolve));
    });
    await flow.settle();
    assert.equal(flow.creates.length, 1);
    assert.equal(flow.posts().length, 1);
    release();
    await flow.settle();
    assert.equal(getState().activeSessionId, flow.sessionId);
    assert.equal(flow.input().value, "");
  });
});

test("a new chat's message that fails opens the chat with its words, once", async () => {
  await newChatFlow("post-fails", { postStatus: 500 }, async (flow) => {
    await flow.click(".mention-access-action.is-primary");
    const sent = flow.input().value.trim();
    await flow.send();
    assert.equal(flow.creates.length, 1);
    assert.equal(getState().activeSessionId, flow.sessionId, "the chat exists, so it opens");
    assert.equal(flow.input().value.trim(), sent, "the words stay to be sent again");
    assert.equal(loadDraft(flow.sessionId).trim(), sent);
    assert.ok(getState().uiError, "and it says so");
    assert.deepEqual(flow.agentSends, []);
  });
});

test("a new chat that cannot be made keeps everything where it was", async () => {
  await newChatFlow("create-fails", { createFails: true }, async (flow) => {
    await flow.click(".mention-access-action.is-primary");
    const sent = flow.input().value.trim();
    await flow.send();
    assert.equal(flow.creates.length, 1);
    assert.equal(flow.posts().length, 0);
    assert.equal(getState().activeSessionId, null);
    assert.equal(flow.input().value.trim(), sent);
    assert.equal(flow.line(), tr("composer.people.access.grantedOne", { names: "Bob" }), "the answer stands");
    assert.ok(getState().uiError);
  });
});

test("where a new chat reaches them anyway nobody is asked", async () => {
  await newChatFlow("inside", { inside: true }, async (flow) => {
    assert.equal(flow.host.querySelector(".mention-access"), null);
    await flow.send();
    assert.equal(flow.creates.length, 1);
    assert.deepEqual(flow.posts()[0]!.body.mentions, ["u-bob"]);
    assert.equal(flow.posts()[0]!.body.shareWith, undefined);
  });
});

test("addressing the agent in a new chat drops the question and stays a prompt", async () => {
  await newChatFlow("agent", {}, async (flow) => {
    await flow.click('.composer-people-toggle button[aria-checked="false"]');
    assert.equal(flow.host.querySelector(".mention-access"), null);
    assert.equal(flow.host.querySelector("button.composer-people-send"), null);
    assert.equal(flow.creates.length, 0);
  });
});
