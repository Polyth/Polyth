// Mounted Studio surface against an in-memory server (real state logic).
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);
const dom = new Window({ url: "http://127.0.0.1:4400/", settings: { disableIframePageLoading: true } });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  File: dom.File,
  localStorage: dom.localStorage,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16) as unknown as number,
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement, Fragment } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: StudioView } = await import("../widgets/StudioView.tsx");
const { default: ReturnToStudio } = await import("../widgets/ReturnToStudio.tsx");
const { pollDelay, codesKey } = await import("../widgets/useStudio.ts");
const { previewDocument } = await import("../widgets/preview.ts");
const { curvePath } = await import("../widgets/Timeline.tsx");
const { glowColors } = await import("../widgets/Stage.tsx");
const { pendingStarts } = await import("../widgets/start.ts");
const { applyStudioPatch, createStudioState } = await import("../src/index.ts");
type StudioState = import("../src/index.ts").StudioState;

const SESSION = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const NEW_SESSION = "7a2d3c4b-5e6f-4a70-8b8c-9d0e1f2a3b4c";
const realFetch = globalThis.fetch;
const timers = new Set<ReturnType<typeof setTimeout>>();
after(async () => {
  globalThis.fetch = realFetch;
  for (const timer of timers) clearTimeout(timer);
  await dom.happyDOM.close();
});

// ------------------------------------------------------------ fake server

interface Server { state: StudioState | null; requests: Array<{ method: string; path: string; body?: unknown; session?: string }>; revision: number }
let server: Server;
const analysis = {
  version: 1, source: "song.mp3", durationSec: 12, sampleRate: 22050, bpm: 120, bpmConfidence: 0.7,
  beats: Array.from({ length: 24 }, (_, i) => i * 0.5), downbeats: Array.from({ length: 6 }, (_, i) => i * 2), beatsPerBar: 4,
  key: { tonic: "A", mode: "minor", confidence: 0.6 },
  sections: [{ start: 0, end: 4, group: "A", kind: "intro", energy: 0.4 }, { start: 4, end: 12, group: "B", kind: "chorus", energy: 1 }],
  instruments: ["drums", "bass", "vocals", "harmony", "highs"].map((id) => ({ id, activity: Array.from({ length: 24 }, (_, i) => (i % 3) / 2), coverage: 0.5 })),
  accents: [4], curve: { rate: 20, rms: Array.from({ length: 240 }, (_, i) => (i % 20) / 20), low: [], mid: [], high: [], onset: [] },
  lyrics: { source: "text", lines: [{ start: 4, end: 6, text: "hello neon" }] }, warnings: ["Lyric timing is estimated."],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// The live model catalog the studio pickers read.
const harnessSnapshots = [{
  identity: { id: "opencode", name: "OpenCode", integration: "opencode" },
  availability: { state: "available", checkedAt: 1 },
  policy: { enabled: true, priority: 1, autoSelect: true },
  context: { spaceId: "s1", projectId: "p1", cwd: "/tmp", revision: "1", fetchedAt: 1 },
  catalog: { models: [
    { providerID: "anthropic", modelID: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", variants: ["low", "high"] },
    { providerID: "anthropic", modelID: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ] },
}];

beforeEach(() => {
  localStorage.clear();
  pendingStarts.clear();
  server = { state: null, requests: [], revision: 1 };
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1:4400");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ? "<binary>" : undefined;
    const path = url.pathname.replace("/api/creative-studio/", "");
    const session = url.searchParams.get("sessionId") ?? (body as { sessionId?: string } | undefined)?.sessionId;
    server.requests.push({ method, path, body, ...(session ? { session } : {}) });
    if (path === "state" && method === "GET") {
      if (url.searchParams.get("since") === String(server.revision)) return json({ unchanged: true, revision: String(server.revision) });
      return json({ revision: String(server.revision), state: server.state });
    }
    if (path === "state" && method === "POST") {
      const input = body as { init?: Record<string, unknown>; patch?: Record<string, unknown> };
      server.state = input.init ? createStudioState(SESSION, input.init as never) : applyStudioPatch(server.state!, input.patch as never, { defaultRole: "user" });
      server.revision++;
      return json({ state: server.state });
    }
    if (path === "upload") {
      const name = url.searchParams.get("name")!;
      const relative = `.polyth/creative-studio/${session}/audio/${name}`;
      if (server.state && /\.mp3$/.test(name)) server.state = applyStudioPatch(server.state, { audio: { path: relative } });
      server.revision++;
      return json({ path: relative, kind: /\.mp3$/.test(name) ? "audio" : "lyrics", size: 3 });
    }
    if (path === "analysis") return json({ analysis: server.state?.audio?.analyzedAt ? analysis : null });
    if (url.pathname === "/api/harnesses/snapshots") return json(harnessSnapshots);
    if (path === "scenes") return json({ codes: {} });
    if (path === "render/cancel") return json({ cancelled: true });
    if (path === "render" || path === "analyze") return json({});
    return json({ error: "not-found", message: path }, 404);
  }) as typeof fetch;
});

// ------------------------------------------------------------------ mount

interface Calls {
  sent: Array<[string, string, unknown]>; inserted: string[]; started: Array<[string, unknown]>; submitted: number;
  closed: number; opened: string[]; activated: string[]; resources: unknown[]; draft: unknown[];
}
type Props = Record<string, unknown> & { children?: unknown };
const strip = (props: Props, ...keys: string[]) => Object.fromEntries(Object.entries(props).filter(([key]) => !keys.includes(key)));
const Button = (props: Props) => createElement("button", { type: (props.type as string) ?? "button", disabled: props.disabled as boolean, className: props.className as string, onClick: props.onClick as () => void }, props.children as never);
const IconButton = (props: Props) => createElement("button", { type: (props.type as string) ?? "button", disabled: props.disabled as boolean, className: props.className as string, "aria-label": props.label as string, onClick: props.onClick as () => void });
const Tabs = (props: { tabs: Array<{ id: string; label: unknown }>; value: string; onChange(id: string): void }) =>
  createElement("div", { role: "tablist" }, props.tabs.map((tab) => createElement("button", { key: tab.id, role: "tab", "data-id": tab.id, "aria-selected": tab.id === props.value, onClick: () => props.onChange(tab.id) }, tab.label as never)));
const Textarea = (props: Props) => createElement("textarea", strip(props, "autoGrow", "minRows", "maxRows", "invalid") as never);
const TextInput = (props: Props) => createElement("input", strip(props, "invalid", "uiSize") as never);
const Checkbox = (props: { checked: boolean; label: string; onChange(value: boolean): void }) =>
  createElement("label", { className: "test-checkbox" }, createElement("input", { type: "checkbox", checked: props.checked, onChange: (event: { target: { checked: boolean } }) => props.onChange(event.target.checked) }), props.label);
const Menu = (props: { entries: Array<{ id: string; label: string; onSelect(): void } | "separator">; children(trigger: Record<string, unknown>): unknown }) =>
  createElement(Fragment, null, props.children({ onClick: () => undefined }) as never, props.entries.map((entry) => entry === "separator" ? null : createElement("button", { key: entry.id, "data-menu": entry.id, onClick: entry.onSelect }, entry.label)));
const EmptyState = (props: { title: string; description?: string }) => createElement("div", { className: "empty" }, props.title, props.description);
const Dialog = (props: { title: string; onClose(): void; children?: unknown }) => createElement("div", { className: "test-dialog", role: "dialog" }, createElement("h2", null, props.title), props.children as never);

interface MountOptions { sessionId?: string | null; locale?: string; status?: string; attention?: { questions: number; permissions: number }; submitDraft?: boolean | null; profile?: string; railPlugin?: string | null }

async function mount(options: MountOptions = {}) {
  const calls: Calls = { sent: [], inserted: [], started: [], submitted: 0, closed: 0, opened: [], activated: [], resources: [], draft: [] };
  let sessionId = options.sessionId === undefined ? SESSION : options.sessionId;
  const sessions: Record<string, Record<string, unknown>> = {
    [SESSION]: { id: SESSION, purpose: "creative-studio", status: options.status ?? "idle", createdAt: 1, tokenTotals: { input: 12000, output: 3000 }, costTotal: 0.42, ...(options.attention ? { attention: options.attention } : {}) },
  };
  const listeners = new Set<() => void>();
  const snapshot = { activeProjectId: "p1", activeSessionId: sessionId, workbenchProfile: options.profile ?? "creative-studio", railPlugin: options.railPlugin === undefined ? "creative-studio" : options.railPlugin };
  const host = {
    store: { subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }, getSnapshot: () => snapshot },
    sessions: {
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      get: (id: string) => sessions[id],
      events: () => [],
    },
    ui: { Dialog, locale: { get: () => options.locale ?? "en", translate: (key: string) => key }, components: { Button, IconButton, Tabs, Textarea, TextInput, Checkbox, Menu, EmptyState } },
    executionDraft: {
      get: () => ({ harnessSelection: { mode: "auto" } }),
      update: (_projectId: string, patch: unknown) => { calls.draft.push(patch); return patch; },
      subscribe: () => () => undefined,
      clear: () => undefined,
    },
    errors: { friendly: (action: string, cause: unknown) => `${action}: ${(cause as Error).message}` },
    conversation: {
      send: async (id: string, text: string, sendOptions?: unknown) => { calls.sent.push([id, text, sendOptions]); return true; },
      insert: (text: string) => { calls.inserted.push(text); },
      startNewSession: (projectId: string, seed: unknown) => { calls.started.push([projectId, seed]); },
      ...(options.submitDraft === null ? {} : { submitDraft: () => { calls.submitted += 1; return options.submitDraft ?? true; } }),
    },
    workbench: {
      openSurface: (id: string) => { calls.opened.push(id); return true; },
      activateProfile: (id: string) => { calls.activated.push(id); return true; },
    },
    navigation: {
      closeWorkspacePane: () => { calls.closed += 1; },
      openResource: (ref: unknown) => { calls.resources.push(ref); },
      revealResource: (ref: unknown) => { calls.resources.push(ref); },
    },
  } as never;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = () => root.render(createElement(StudioView, { host, projectId: "p1", sessionId, active: true } as never));
  await act(async () => { render(); });
  const settle = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => { const timer = setTimeout(resolve, 0); timers.add(timer); }); });
  };
  await settle();
  const unmount = async () => { await act(async () => root.unmount()); container.remove(); };
  /** The shell activates another chat (e.g. the one a first send created). */
  const switchSession = async (id: string | null, session?: Record<string, unknown>) => {
    if (id && session) sessions[id] = session;
    sessionId = id;
    snapshot.activeSessionId = id;
    await act(async () => { render(); });
    await settle(10);
  };
  const notify = async () => { await act(async () => { for (const listener of [...listeners]) listener(); }); };
  return { container, calls, settle, unmount, switchSession, sessions, notify, snapshot };
}

const byText = (container: Element, selector: string, text: string | RegExp) =>
  [...container.querySelectorAll(selector)].find((element) => typeof text === "string" ? element.textContent?.trim() === text : text.test(element.textContent ?? "")) as HTMLElement | undefined;
const click = async (element: Element | undefined | null) => {
  assert.equal(Boolean(element), true, "element exists");
  await act(async () => { (element as HTMLElement).click(); });
};
const type = async (element: Element | null, value: string) => {
  assert.equal(Boolean(element), true, "field exists");
  const proto = element instanceof dom.HTMLInputElement ? dom.HTMLInputElement.prototype : dom.HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element!.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
};
const setFile = async (input: Element | null, file: File) => {
  assert.equal(Boolean(input), true, "file input exists");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input!.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event); });
};
const submit = async (view: { container: Element; settle(rounds?: number): Promise<void> }) => {
  const button = view.container.querySelector(".cs-create-foot button[type=submit]");
  assert.equal(Boolean(button), true, "submit button exists");
  await act(async () => { (button as HTMLElement).click(); });
  await view.settle(4);
};
/** Real time passes (the start waits for the shell to paint the seeded draft). */
const waitFor = async (view: { settle(rounds?: number): Promise<void> }, done: () => boolean, ms = 1500) => {
  const until = Date.now() + ms;
  while (!done() && Date.now() < until) {
    await act(async () => { await new Promise((resolve) => { const timer = setTimeout(resolve, 20); timers.add(timer); }); });
  }
  await view.settle();
};
const stepLabel = (container: Element) => container.querySelector(".cs-steps li[data-state=current] .cs-step-label")?.textContent;
const song = () => new dom.File(["abc"], "My Song!.mp3", { type: "audio/mpeg" }) as unknown as File;

function fixture(): StudioState {
  let state = createStudioState(SESSION, { idea: "A neon city dances to the beat", durationSec: 12, effort: "balanced", audioPath: "song.mp3" }, 1000);
  state = applyStudioPatch(state, {
    title: "Neon City",
    scenes: [
      { id: "intro", title: "Skyline", start: 0, end: 4, renderer: "svg", description: "Vector skyline wakes up on the downbeat" },
      { id: "drop", title: "Drop", start: 4, end: 12, renderer: "three", description: "3D towers jump with the chorus", transition: { kind: "flash", duration: 0.3 } },
    ],
    styleGuide: { palette: ["#0b0b14", "#f4f1ea", "#7c6cff"] },
    stages: { brief: { status: "skipped" }, concept: { status: "awaiting-approval", note: "Two scenes" } },
    findings: [{ id: "f1", severity: "error", message: "Scene renders as a flat black frame", sceneId: "drop", time: 5, source: "qa" }],
    activity: [{ role: "planner", message: "Storyboard drafted", stage: "concept" }],
  }, { now: 2000 });
  state.audio = { path: "song.mp3", name: "song.mp3", analyzedAt: 1500, durationSec: 12, bpm: 120, key: "A minor" };
  return state;
}
const running = (state: StudioState) => {
  state.renders.push({ id: "r1", kind: "preview", status: "running", progress: 0.4, framesDone: 72, framesTotal: 180, width: 640, height: 360, fps: 15, startedAt: Date.now(), heartbeatAt: Date.now() });
  return state;
};

// ------------------------------------------------------------------ tests

test("pure helpers: poll cadence, code keys, curve path, preview document, glow colours", () => {
  assert.equal(pollDelay({ active: true, working: false, rendering: true, failed: false, exists: true }), 700);
  assert.equal(pollDelay({ active: false, working: true, rendering: true, failed: false, exists: true }), 4000);
  assert.equal(codesKey(null), "");
  assert.equal(codesKey(fixture()), "intro:0|drop:0");
  assert.match(curvePath([0, 1, 0.5], 1, 3), /^M0,100 L0\.0,100\.0 L333\.3,8\.0/);
  const html = previewDocument();
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /__studio/);
  assert.ok(!/<\/script>[\s\S]*<\/script>[\s\S]*<\/script>/.test(html), "exactly two scripts");
  // The theater glows with the palette's vivid colours, not its paper or ink.
  assert.deepEqual(glowColors(["#0e1024", "#f6efe3", "#ff7a59", "#7c6cff", "#2ec4b6"]), ["#ff7a59", "#7c6cff", "#2ec4b6"]);
  assert.deepEqual(glowColors(["not a colour"]), []);
});

test("guided flow: five steps, presets, a local song card and a generated brief", async () => {
  const view = await mount();
  assert.equal(Boolean(view.container.querySelector(".cs-create")), true, "the create flow shows when no studio exists");
  assert.equal(view.container.querySelector(".cs-level[aria-checked=true]")?.textContent, "Guided");
  assert.deepEqual([...view.container.querySelectorAll(".cs-step-label")].map((item) => item.textContent), ["Idea", "Song", "Style", "Format", "Review"]);
  await submit(view);
  assert.equal(stepLabel(view.container), "Idea", "an empty idea blocks the step");
  assert.match(view.container.textContent ?? "", /Describe the idea in at least a sentence/);
  await click(byText(view.container, ".cs-kind strong", "Dance video")?.closest("label"));
  await click(view.container.querySelector(".cs-seed"));
  assert.match((view.container.querySelector(".cs-hero-input") as HTMLTextAreaElement).value, /neon silhouettes/i);
  await submit(view);
  assert.equal(stepLabel(view.container), "Song");
  await setFile(view.container.querySelector(".cs-songcard input[type=file]"), song());
  assert.match(view.container.querySelector(".cs-songcard")?.textContent ?? "", /My Song!\.mp3/);
  assert.equal(view.container.querySelector(".cs-songcard")?.getAttribute("data-filled"), "true");
  await submit(view);
  assert.equal(stepLabel(view.container), "Style");
  await click(byText(view.container, ".cs-chip-toggle", "Dark"));
  await submit(view);
  assert.equal(stepLabel(view.container), "Format");
  await click(byText(view.container, ".cs-choice strong", "Fully on its own")?.closest("label"));
  await submit(view);
  assert.equal(stepLabel(view.container), "Review");
  const summary = view.container.querySelector(".cs-summary")?.textContent ?? "";
  assert.match(summary, /Dance video/);
  assert.match(summary, /My Song!\.mp3/);
  assert.match(summary, /fully autonomous/);
  assert.equal(Boolean(view.container.querySelector(".cs-summary code")), false, "guided users never see delivery paths");
  await submit(view);
  await view.settle(10);
  const init = (server.requests.find((request) => request.method === "POST" && request.path === "state")!.body as { init: Record<string, unknown> }).init;
  assert.equal(init.mediaKind, "dance");
  assert.equal(init.autonomy, "autonomous");
  assert.deepEqual(init.moods, ["energetic", "dark"]);
  assert.deepEqual(init.delivery, { height: 1080, fps: 30, matchSongLength: true, outputPath: "final/music-video.mp4", reportPath: "report.md" });
  assert.ok(server.requests.some((request) => request.path === "upload"));
  const [target, brief] = view.calls.sent[0]!;
  assert.equal(target, SESSION);
  assert.match(brief, /The song file is \.polyth\/creative-studio\/.*\/audio\/My Song!\.mp3\./);
  assert.match(brief, /Work on your own from start to finish/);
  await view.unmount();
});

test("quick flow: one screen, defaults one tap away", async () => {
  localStorage.setItem("polyth.creative-studio.level", "quick");
  const view = await mount();
  assert.equal(view.container.querySelectorAll(".cs-steps").length, 0, "no steps in quick mode");
  assert.equal(Boolean(view.container.querySelector(".cs-songcard")), true, "the song on the same screen");
  await type(view.container.querySelector(".cs-hero-input"), "A paper city where every light dances to the chorus");
  // A default chip switches to guided at the matching step.
  await click(view.container.querySelector(".cs-defaults .cs-chip-toggle"));
  assert.equal(view.container.querySelector(".cs-level[aria-checked=true]")?.textContent, "Guided");
  assert.equal(stepLabel(view.container), "Format");
  await click(byText(view.container, ".cs-level", "Quick"));
  await submit(view);
  await view.settle(8);
  assert.equal(view.calls.sent.length, 1);
  assert.match(view.calls.sent[0]![1], /Show me the storyboard in the Studio panel and wait for my approval/);
  await view.unmount();
});

test("expert flow: delivery spec, rules and an editable brief sent as written", async () => {
  localStorage.setItem("polyth.creative-studio.level", "expert");
  const view = await mount();
  assert.equal(view.container.querySelectorAll(".cs-steps li").length, 7);
  await type(view.container.querySelector(".cs-hero-input"), "Visualizer world of rings that breathe with the bass");
  for (const expected of ["Song", "Style", "Format", "Models", "Delivery"]) {
    await submit(view);
    assert.equal(stepLabel(view.container), expected);
  }
  assert.equal(view.container.querySelectorAll(".cs-rules .test-checkbox").length, 6);
  const output = view.container.querySelector("input.cs-mono");
  await type(output, "../escape.mp4");
  await submit(view);
  assert.equal(stepLabel(view.container), "Delivery", "an escaping path blocks delivery");
  await type(output, "out/clip.mp4");
  await click(byText(view.container, ".cs-seg button", "4K"));
  await submit(view);
  assert.equal(stepLabel(view.container), "Review");
  const editor = view.container.querySelector("textarea.cs-brief") as HTMLTextAreaElement;
  assert.match(editor.value, /out\/clip\.mp4, 3840×2160/);
  await type(editor, "CUSTOM BRIEF written by an expert");
  assert.match(view.container.textContent ?? "", /Edited/);
  await submit(view);
  await view.settle(8);
  assert.deepEqual(view.calls.sent.at(-1)!.slice(0, 2), [SESSION, "CUSTOM BRIEF written by an expert"]);
  await view.unmount();
});

test("the models step routes work parts and leaves the chat draft alone without a route", async () => {
  localStorage.setItem("polyth.creative-studio.level", "expert");
  const view = await mount({ sessionId: null });
  await type(view.container.querySelector(".cs-hero-input"), "Visualizer world of rings that breathe with the bass");
  while (stepLabel(view.container) !== "Format") await submit(view);
  // Format carries the session picker (Auto by default).
  assert.equal(view.container.querySelectorAll(".cs-models .cs-model-row").length, 1);
  await submit(view);
  assert.equal(stepLabel(view.container), "Models");
  // Expert adds one picker per work part beside the session picker.
  assert.equal(view.container.querySelectorAll(".cs-model-grid .cs-model-row").length, 5);
  for (const label of ["Plan & storyboard", "Scene descriptions", "Scene code", "Review & fixes", "Delivery report"]) {
    assert.equal(Boolean(byText(view.container, ".cs-model-grid legend", label)), true, label);
  }
  await submit(view);
  await submit(view);
  assert.equal(stepLabel(view.container), "Review");
  assert.match(view.container.textContent ?? "", /Auto/, "the review summary shows the session route");
  await submit(view);
  await view.settle(8);
  // Auto writes an explicit auto selection, never a fabricated model route.
  assert.deepEqual(view.calls.draft, [{ harnessSelection: { mode: "auto" }, harnessSelectionExplicit: true }]);
  const seed = view.calls.started[0]![1] as { draft: string };
  assert.doesNotMatch(seed.draft, /Models \(use agent\.models/);
  await view.unmount();
});

test("without a chat: the brief creates it through the composer, then the song follows into the new chat", async () => {
  localStorage.setItem("polyth.creative-studio.level", "quick");
  const view = await mount({ sessionId: null });
  assert.equal(Boolean(view.container.querySelector(".cs-songcard")), true, "a song can be chosen before the chat exists");
  await type(view.container.querySelector(".cs-hero-input"), "Lyric video for a calm acoustic song");
  await setFile(view.container.querySelector(".cs-songcard input[type=file]"), song());
  await submit(view);
  await waitFor(view, () => view.calls.submitted > 0);
  assert.equal(view.calls.started.length, 1);
  const [projectId, seed] = view.calls.started[0]! as [string, { draft: string; title: string }];
  assert.equal(projectId, "p1");
  assert.match(seed.draft, /\[Creative Studio\] New media/);
  assert.match(seed.draft, /uploading the song/);
  assert.equal(seed.title, "Lyric video for a calm acoustic song");
  assert.equal(view.calls.submitted, 1, "the composer sends the seeded brief");
  assert.equal(server.requests.filter((request) => request.method === "POST").length, 0, "nothing is uploaded before the chat exists");
  assert.equal(Boolean(view.container.querySelector(".cs-setup")), true, "a setup screen waits for the chat");

  // The first send creates the chat; the studio adopts it and uploads the song.
  await view.switchSession(NEW_SESSION, { id: NEW_SESSION, purpose: "creative-studio", status: "working", createdAt: Date.now() });
  const posts = server.requests.filter((request) => request.method === "POST");
  assert.deepEqual(posts.map((request) => request.path), ["state", "upload"]);
  assert.equal(posts[1]!.session, NEW_SESSION, "the song goes to the new chat's checkout");
  assert.equal(view.calls.sent.length, 0, "the brief is not sent twice");
  assert.equal(pendingStarts.get("p1"), null);
  await view.unmount();
});

test("without a composer to send it, the brief waits in the revealed conversation", async () => {
  localStorage.setItem("polyth.creative-studio.level", "quick");
  const view = await mount({ sessionId: null, submitDraft: false });
  await type(view.container.querySelector(".cs-hero-input"), "Visualizer of rings breathing with the bass");
  await submit(view);
  await waitFor(view, () => view.calls.closed > 0);
  assert.equal(view.calls.submitted, 1);
  assert.equal(view.calls.closed, 1, "the studio reveals its conversation with the draft");
  assert.match(view.container.textContent ?? "", /Send the brief from the conversation to start/);
  await click(byText(view.container, "button", "Start over"));
  assert.equal(Boolean(view.container.querySelector(".cs-create")), true);
  await view.unmount();
});

test("studio: header, pipeline, stage, filmstrip, next step and views", async () => {
  server.state = fixture();
  const view = await mount({ status: "working" });
  const text = view.container.textContent ?? "";
  assert.match(text, /Neon City/);
  assert.match(text, /Working/);
  assert.match(text, /Storyboard/);
  assert.equal(view.container.querySelectorAll(".cs-pipeline-seg").length, 6);
  assert.equal(view.container.querySelector(".cs-pipeline-seg[data-current]")?.getAttribute("data-status"), "awaiting-approval");
  assert.equal(Boolean(view.container.querySelector("iframe[sandbox='allow-scripts']")), true, "live preview is sandboxed");
  assert.equal(view.container.querySelectorAll(".cs-film-scene").length, 2);
  assert.equal(view.container.querySelectorAll(".cs-film-section").length, 2);
  assert.ok(view.container.querySelector(".cs-film-energy")?.getAttribute("d")?.startsWith("M0,100"));
  assert.equal(view.container.querySelector(".cs-moment")?.getAttribute("data-kind"), "approve");
  assert.equal(view.container.querySelector("[role=tab][aria-selected=true]")?.getAttribute("data-id"), "scenes");
  assert.equal(view.container.querySelectorAll(".cs-scene").length, 2);
  assert.equal(byText(view.container, "[role=tab]", /Review/)?.querySelector(".cs-count")?.textContent, "1");
  await click(byText(view.container, "[role=tab]", /Progress/));
  assert.match(view.container.textContent ?? "", /You approved the storyboard/);
  assert.match(view.container.textContent ?? "", /Storyboard drafted/);
  assert.match(view.container.textContent ?? "", /15k tokens · \$0\.42/);
  await view.unmount();
});

test("approving the storyboard patches state and tells the agent", async () => {
  server.state = fixture();
  const view = await mount();
  assert.match(view.container.querySelector(".cs-status")?.textContent ?? "", /Needs you/, "a storyboard waiting for approval is the person's turn");
  await click(byText(view.container, ".cs-moment button", "Approve storyboard"));
  await view.settle();
  const patch = server.requests.find((request) => request.method === "POST" && request.path === "state")!.body as { patch: { approve: string } };
  assert.equal(patch.patch.approve, "concept");
  assert.deepEqual(view.calls.sent.at(-1)!.slice(0, 2), [SESSION, "[Creative Studio] Storyboard approved. Continue with production."]);
  assert.ok(server.state!.approvals.concept);
  await view.unmount();
});

test("changing a scene: the dock names it, the agent gets the scene context, the log records it", async () => {
  server.state = fixture();
  const view = await mount();
  await click(view.container.querySelector(".cs-scene .cs-scene-main"));
  assert.equal(view.container.querySelector(".cs-scene")?.getAttribute("data-selected"), "true");
  await click(byText(view.container, ".cs-scene-more button", "Change"));
  assert.match(view.container.querySelector(".cs-dock-scope")?.textContent ?? "", /Skyline/);
  const field = view.container.querySelector(".cs-dock-input") as HTMLTextAreaElement;
  assert.match(field.placeholder, /What should change in “Skyline”/);
  await type(field, "make the towers glow");
  await act(async () => { (view.container.querySelector(".cs-dock") as HTMLFormElement).requestSubmit(); });
  await view.settle();
  assert.deepEqual(view.calls.sent.at(-1), [SESSION, "[Creative Studio] Change scene \"Skyline\" (intro, 0:00–0:04): make the towers glow", { delivery: "normal" }]);
  assert.equal(view.container.querySelector(".cs-dock-scope"), null, "the scope clears after sending");
  assert.match(view.container.textContent ?? "", /Sent to the agent/);
  assert.ok(server.state!.activity.some((entry) => entry.role === "user" && entry.message === "make the towers glow" && entry.sceneId === "intro"));
  await view.unmount();
});

test("while the agent works a message waits for its current step", async () => {
  server.state = fixture();
  const view = await mount({ status: "working" });
  const field = view.container.querySelector(".cs-dock-input") as HTMLTextAreaElement;
  assert.match(field.placeholder, /Add a note for the agent/);
  await type(field, "keep the chorus brighter");
  await act(async () => { (view.container.querySelector(".cs-dock") as HTMLFormElement).requestSubmit(); });
  await view.settle();
  assert.deepEqual(view.calls.sent.at(-1), [SESSION, "[Creative Studio] keep the chorus brighter", { delivery: "queue" }]);
  assert.match(view.container.textContent ?? "", /reads it after its current step/);
  await view.unmount();
});

test("review and export: dismiss a finding, ask for a fix, follow a render and stop it", async () => {
  const state = running(fixture());
  state.stages.concept = { status: "done" };
  state.approvals.concept = 1;
  server.state = state;
  const view = await mount();
  await click(byText(view.container, "[role=tab]", /Review/));
  assert.match(view.container.textContent ?? "", /flat black frame/);
  await click(byText(view.container, ".cs-findings button", "Ask to fix"));
  await view.settle();
  assert.match(view.calls.sent.at(-1)![1], /^\[Creative Studio\] Fix this issue: Scene renders as a flat black frame \(drop, 0:05\)$/);
  await click(byText(view.container, ".cs-findings button", "Dismiss"));
  await view.settle();
  assert.equal(server.state!.findings[0]!.status, "dismissed");
  await click(byText(view.container, "[role=tab]", /Export/));
  assert.match(view.container.textContent ?? "", /72 \/ 180 frames/);
  assert.match(view.container.querySelector(".cs-moment")?.textContent ?? "", /Rendering · 40%/);
  await click(byText(view.container, ".cs-job-live button", "Stop"));
  await view.settle();
  assert.ok(server.requests.some((request) => request.path === "render/cancel"));
  await view.unmount();
});

test("a finished video plays on the stage and opens as a file", async () => {
  const state = fixture();
  state.stages.concept = { status: "done" };
  state.approvals.concept = 1;
  state.renders.push({ id: "f1", kind: "final", status: "done", progress: 1, framesDone: 1, framesTotal: 1, width: 1920, height: 1080, fps: 30, startedAt: 1, heartbeatAt: 1, finishedAt: 2, output: `.polyth/creative-studio/${SESSION}/renders/final.mp4`, delivered: "final/music-video.mp4", sceneRevisions: { intro: 0, drop: 0 }, verification: { ok: true, durationSec: 12, problems: [] } });
  state.stages.export = { status: "done" };
  server.state = state;
  const view = await mount();
  assert.equal(view.container.querySelector(".cs-moment")?.getAttribute("data-kind"), "delivered");
  assert.match(view.container.querySelector(".cs-status")?.textContent ?? "", /Ready/);
  await click(byText(view.container, ".cs-moment button", /Watch/));
  assert.match(view.container.querySelector(".cs-stage-video")?.getAttribute("src") ?? "", /renders%2Ffinal\.mp4/);
  assert.equal(view.container.querySelector(".cs-stage-runtime"), null, "the file replaces the live frame");
  await click(byText(view.container, ".cs-chip--action", "Back to live"));
  assert.equal(Boolean(view.container.querySelector(".cs-stage-runtime")), true);
  await click(byText(view.container, ".cs-moment button", "Open file"));
  assert.deepEqual(view.calls.resources.at(-1), { scheme: "file", locator: "final/music-video.mp4", projectId: "p1", sessionId: SESSION });
  await view.unmount();
});

test("when the agent waits for the person, the studio reveals its conversation", async () => {
  server.state = fixture();
  const view = await mount({ status: "waiting", attention: { questions: 0, permissions: 1 } });
  assert.equal(view.container.querySelector(".cs-moment")?.getAttribute("data-kind"), "needs-you");
  await click(byText(view.container, ".cs-moment button", "Open conversation"));
  assert.equal(view.calls.closed, 1, "closing the home surface shows the lane chat beneath it");
  await view.unmount();
});

test("a paused agent continues with one tap; the menu starts a new video", async () => {
  const state = fixture();
  state.stages.concept = { status: "done" };
  state.approvals.concept = 1;
  state.findings = [];
  server.state = state;
  const view = await mount({ status: "idle" });
  assert.equal(view.container.querySelector(".cs-moment")?.getAttribute("data-kind"), "paused");
  await click(byText(view.container, ".cs-moment button", "Continue"));
  await view.settle();
  assert.match(view.calls.sent.at(-1)![1], /^\[Creative Studio\] Continue the video/);
  await click(view.container.querySelector("[data-menu=new]"));
  assert.deepEqual(view.calls.started.at(-1), ["p1", undefined]);
  await view.unmount();
});

test("the chat going away for a moment never shows the previous chat's studio", async () => {
  server.state = fixture();
  const view = await mount();
  assert.equal(Boolean(view.container.querySelector(".cs-studio")), true);
  // Re-entering the lane: no active chat until the remembered one opens.
  await view.switchSession(null);
  assert.equal(view.container.querySelector(".cs-studio"), null, "no stale studio without a chat");
  assert.equal(Boolean(view.container.querySelector(".cs-create")), true, "a fresh lane chat offers a new video");
  await view.switchSession(SESSION);
  assert.equal(Boolean(view.container.querySelector(".cs-studio")), true);
  await view.unmount();
});

test("Ukrainian copy", async () => {
  server.state = fixture();
  const view = await mount({ locale: "uk" });
  const text = view.container.textContent ?? "";
  assert.match(text, /Розкадрування готове/);
  assert.match(text, /Затвердити розкадрування/);
  assert.match(text, /Сцени/);
  assert.match(text, /Якість/);
  await view.unmount();
});

test("the studio's own chat offers the way back to the studio", async () => {
  const listeners = new Set<() => void>();
  const snapshot = { workbenchProfile: "creative-studio", railPlugin: null as string | null };
  const activated: string[] = [];
  const purpose = { value: "creative-studio" };
  const host = {
    store: { subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }, getSnapshot: () => snapshot },
    sessions: { subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }, get: () => ({ id: SESSION, status: "idle", purpose: purpose.value }) },
    ui: { locale: { get: () => "en" } },
    workbench: { activateProfile: (id: string) => { activated.push(id); return true; } },
  } as never;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(ReturnToStudio, { host, sessionId: SESSION })); });
  await click(byText(container, "button", /Back to the studio/));
  assert.deepEqual(activated, ["creative-studio"]);
  // Hidden while the studio covers the chat, outside its profile, or for other chats.
  snapshot.railPlugin = "creative-studio";
  await act(async () => { for (const listener of [...listeners]) listener(); });
  assert.equal(container.textContent, "");
  snapshot.railPlugin = null;
  snapshot.workbenchProfile = "conversation";
  await act(async () => { for (const listener of [...listeners]) listener(); });
  assert.equal(container.textContent, "");
  snapshot.workbenchProfile = "creative-studio";
  purpose.value = "playground";
  await act(async () => { for (const listener of [...listeners]) listener(); });
  assert.equal(container.textContent, "");
  await act(async () => root.unmount());
  container.remove();
});
