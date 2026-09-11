import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import type { CapabilityMutability, CapabilityProjectionMode, HarnessSnapshot } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
  cancelAnimationFrame: () => {},
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type RequestRecord = { method: string; path: string; body?: unknown };
let snapshots: HarnessSnapshot[] = [];
let failure: { path: string; message: string; when?: (url: URL) => boolean } | undefined;
const requests: RequestRecord[] = [];

globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), "http://localhost:3000");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
  requests.push({ method, path: `${url.pathname}${url.search}`, body });
  if (failure?.path === url.pathname && (!failure.when || failure.when(url))) {
    return new Response(JSON.stringify({ message: failure.message }), { status: 503 });
  }
  if (url.pathname === "/api/harnesses/roster") {
    return new Response(JSON.stringify(snapshots.map((row) => ({
      identity: { id: row.identity.id, name: row.identity.name, integration: row.identity.integration },
      policy: row.policy,
    }))));
  }
  if (url.pathname === "/api/harnesses/preferences") return new Response(JSON.stringify({}));
  if (url.pathname === "/api/harnesses/snapshots") {
    const selected = url.searchParams.get("harnessId");
    return new Response(JSON.stringify(selected ? snapshots.filter((row) => row.identity.id === selected) : snapshots));
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { HarnessSettings } = await import("../widgets/runtime.tsx");
const { configurationSections, projectionFacts } = await import("../widgets/presentation.ts");

const flush = async (rounds = 5) => {
  for (let index = 0; index < rounds; index++) await act(async () => { await Promise.resolve(); });
};

const host = (projectId: string, sections: Array<{ id: string; order: number; meta?: Record<string, unknown> }> = []): WebPackageHost => ({
  slots: {
    register: () => () => {},
    list: () => sections,
  },
  store: {
    select: () => projectId,
    getSnapshot: () => ({ activeProjectId: projectId } as never),
    subscribe: () => () => {},
  },
  errors: { friendly: (_action: string, cause: unknown) => cause instanceof Error ? cause.message : String(cause) },
  ui: {
    Slot: ({ context }: { context?: Record<string, unknown> }) => createElement("div", { className: "fake-contributed-settings" }, `contributed:${String(context?.sectionId ?? "")}`),
  },
} as unknown as WebPackageHost);

const row = (id: string, priority: number, over: Partial<HarnessSnapshot> = {}): HarnessSnapshot => ({
  identity: { id, name: id === "codex" ? "Codex" : id === "cursor" ? "Cursor" : "Manual", integration: `${id} protocol`, version: "1.0" },
  policy: { enabled: true, priority, autoSelect: id !== "cursor" },
  availability: { harnessId: id, state: "ready", installed: true, healthy: true, authenticated: true, checkedAt: 1 },
  context: { spaceId: "space-a", projectId: "p", cwd: "/project", revision: "r1", fetchedAt: 1 },
  ...over,
});

const richCodex = (projectId: string): HarnessSnapshot => row("codex", 10, {
  context: { spaceId: "space-a", projectId, cwd: "/project", revision: "r1", fetchedAt: 1 },
  configuration: {
    pendingChanges: 2,
    restartRequired: true,
    controls: [],
  },
  capabilitySupport: {
    harnessId: "codex",
    kinds: {
      "mcp-server": { modes: ["mcp"], mutability: "immediate", configScope: "project" },
      tool: { modes: ["unsupported"], mutability: "immutable" },
    },
  },
  capabilities: { streaming: true, permissions: false, questions: false, compaction: true, subagents: true, resume: true, fork: false, contextOccupancy: undefined },
});

async function mountSettings(testSnapshots: HarnessSnapshot[], projectId: string, sections: Array<{ id: string; order: number; meta?: Record<string, unknown> }> = [], settingsTarget?: { itemId?: string; sectionId?: string }) {
  snapshots = testSnapshots;
  failure = undefined;
  requests.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(HarnessSettings, { host: host(projectId, sections), settingsTarget })); });
  await flush();
  return {
    container,
    root,
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

test("Auto resolves the first ready eligible harness, while manual-only and disabled rows stay out of Auto", async () => {
  const projectId = "settings-auto";
  const view = await mountSettings([
    row("manual", 0, { policy: { enabled: true, priority: 0, autoSelect: false } }),
    row("disabled", 10, { policy: { enabled: false, priority: 10, autoSelect: true } }),
    richCodex(projectId),
    row("cursor", 30, { policy: { enabled: true, priority: 30, autoSelect: true } }),
  ], projectId);
  try {
    assert.match(view.container.textContent ?? "", /Default for new sessionsAuto → Codex/);
    const codex = view.container.querySelector(".pkg-harnesses-row-main strong");
    assert.equal(codex?.textContent, "Manual");
    assert.match(view.container.textContent ?? "", /Manual only/);
    assert.match(view.container.textContent ?? "", /Auto #1/);
    assert.match(view.container.textContent ?? "", /Disabled/);
  } finally {
    await view.unmount();
  }
});

test("mounted settings project metadata shows projection support, unknown facts, unsupported facts, and pending restart state", async () => {
  const projectId = "settings-metadata";
  const view = await mountSettings([richCodex(projectId)], projectId);
  try {
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".pkg-harnesses-row-main")?.click(); });
    await flush();
    const text = view.container.textContent ?? "";
    assert.match(text, /2 changes pending/);
    assert.match(text, /Restart required/);
    assert.match(text, /via MCP/);
    assert.match(text, /Unsupported/);
    assert.match(text, /Not verified/);
    const labels = [...view.container.querySelectorAll<HTMLElement>(".pkg-harnesses-chip")].map((item) => item.getAttribute("aria-label") ?? "").join("\n");
    assert.match(labels, /Configuration scope: project/);
  } finally {
    await view.unmount();
  }
});

test("contributed arbitrary settings appear, open their detail section, and row controls do not open detail", async () => {
  const projectId = "settings-contributions";
  const sections = [{ id: "contribution-registration", order: 20, meta: { harnessId: "codex", sectionId: "custom", label: "Custom settings", handlesPendingChanges: true } }];
  const view = await mountSettings([richCodex(projectId), row("cursor", 20)], projectId, sections);
  try {
    const switchControl = view.container.querySelector<HTMLButtonElement>('[role="switch"]');
    assert.ok(switchControl);
    await act(async () => { switchControl!.click(); });
    await flush();
    assert.equal(view.container.querySelector(".pkg-harnesses-detail"), null, "switching policy must not open detail");
    const preference = requests.find((request) => request.method === "PUT");
    assert.deepEqual((preference?.body as { preferences: Record<string, unknown> } | undefined)?.preferences.codex, { enabled: false, priority: 0 });

    await act(async () => { view.container.querySelector<HTMLButtonElement>(".pkg-harnesses-row-main")?.click(); });
    await flush();
    assert.ok(view.container.querySelector(".pkg-harnesses-detail"), "row opens detail");
    assert.ok(requests.some((request) => request.path.includes("harnessId=codex") && request.path.includes("detail=1")), "detail fetch is scoped to selected harness");
    assert.match(view.container.textContent ?? "", /Custom settings/);
    const review = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Review changes");
    assert.ok(review, "a contribution that handles pending changes owns the review route");
    await act(async () => { review!.click(); });
    await flush();
    assert.match(view.container.textContent ?? "", /contributed:custom/);
    assert.match(view.container.textContent ?? "", /Harnesses/);
  } finally {
    await view.unmount();
  }
});

test("keyboard reorder sends ordered harness preferences", async () => {
  const projectId = "settings-reorder";
  const view = await mountSettings([row("codex", 10), row("cursor", 20)], projectId);
  try {
    const down = view.container.querySelector<HTMLButtonElement>('[aria-label="Move Codex down"]');
    assert.ok(down);
    await act(async () => { down!.click(); });
    await flush();
    const preference = requests.find((request) => request.method === "PUT");
    assert.deepEqual(preference?.body, { preferences: { cursor: { enabled: true, priority: 0 }, codex: { enabled: true, priority: 10 } } });
  } finally {
    await view.unmount();
  }
});

test("drag reorder sends the same ordered harness preferences as keyboard controls", async () => {
  const projectId = "settings-drag-reorder";
  const view = await mountSettings([row("codex", 10), row("cursor", 20)], projectId);
  try {
    const source = view.container.querySelector<HTMLElement>(".pkg-harnesses-row:first-child .pkg-harnesses-drag");
    const target = view.container.querySelector<HTMLElement>(".pkg-harnesses-row:nth-child(2)");
    assert.ok(source);
    assert.ok(target);
    let dragged = "";
    const dataTransfer = {
      setData: (_format: string, value: string) => { dragged = value; },
      getData: (_format: string) => dragged,
    } as unknown as DataTransfer;
    const dragStart = new dom.Event("dragstart", { bubbles: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
    const dragOver = new dom.Event("dragover", { bubbles: true, cancelable: true });
    const drop = new dom.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    await act(async () => {
      source!.dispatchEvent(dragStart as unknown as Event);
      target!.dispatchEvent(dragOver as unknown as Event);
      target!.dispatchEvent(drop as unknown as Event);
    });
    await flush();
    const preference = requests.find((request) => request.method === "PUT");
    assert.deepEqual(preference?.body, { preferences: { cursor: { enabled: true, priority: 0 }, codex: { enabled: true, priority: 10 } } });
  } finally {
    await view.unmount();
  }
});

test("auth-required harness opens a sign-in command review dialog", async () => {
  const projectId = "settings-sign-in";
  const view = await mountSettings([row("codex", 10, {
    availability: { harnessId: "codex", state: "auth-required", installed: true, healthy: true, authenticated: false, checkedAt: 1 },
    setup: { signInCommand: "codex auth login", setupUrl: "https://example.test/setup" },
  })], projectId);
  try {
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".pkg-harnesses-row-main")?.click(); });
    await flush();
    const signIn = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Sign in");
    assert.ok(signIn);
    await act(async () => { signIn!.click(); });
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    assert.equal(dialog?.getAttribute("aria-label"), "Sign in to Codex");
    assert.match(dialog?.textContent ?? "", /codex auth login/);
    assert.match(dialog?.textContent ?? "", /Run command/);
  } finally {
    await view.unmount();
    document.body.querySelector<HTMLElement>('[role="dialog"]')?.remove();
  }
});

test("selected harness detail remains visible when its metadata request fails", async () => {
  const projectId = "settings-detail-error";
  const view = await mountSettings([row("codex", 10)], projectId);
  try {
    failure = { path: "/api/harnesses/snapshots", message: "detail unavailable", when: (url) => url.searchParams.has("harnessId") };
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".pkg-harnesses-row-main")?.click(); });
    await flush();
    assert.ok(view.container.querySelector(".pkg-harnesses-detail"));
    assert.match(view.container.querySelector("[role=alert]")?.textContent ?? "", /detail unavailable/);
  } finally {
    await view.unmount();
  }
});

test("settings target opens a contributed section and a new same-valued target reopens it after Back", async () => {
  const projectId = "settings-target";
  const sections = [{ id: "contribution-registration", order: 20, meta: { harnessId: "codex", sectionId: "custom", label: "Custom settings" } }];
  const view = await mountSettings([richCodex(projectId)], projectId, sections, { itemId: "codex", sectionId: "custom" });
  try {
    await flush();
    assert.match(view.container.textContent ?? "", /contributed:custom/);
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".pkg-harnesses-settings-actions button")?.click(); });
    await flush();
    assert.equal(view.container.querySelector(".pkg-harnesses-detail"), null, "Back returns to the list");
    await act(async () => {
      view.root.render(createElement(HarnessSettings, {
        host: host(projectId, sections),
        settingsTarget: { itemId: "codex", sectionId: "custom" },
      }));
    });
    await flush();
    assert.match(view.container.textContent ?? "", /contributed:custom/, "a new target object with the same values reopens the section");
  } finally {
    await view.unmount();
  }
});

test("settings reports catalog errors and detail navigation returns to the harness list", async () => {
  const projectId = "settings-errors";
  const view = await mountSettings([row("codex", 10)], projectId);
  try {
    failure = { path: "/api/harnesses/snapshots", message: "catalog unavailable" };
    await act(async () => { view.container.querySelector<HTMLButtonElement>("[aria-label='Refresh harnesses']")?.click(); });
    await flush();
    assert.match(view.container.querySelector("[role=alert]")?.textContent ?? "", /catalog unavailable/);
    failure = undefined;
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".pkg-harnesses-row-main")?.click(); });
    await flush();
    assert.ok(view.container.querySelector(".pkg-harnesses-detail"));
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".pkg-harnesses-settings-actions button")?.click(); });
    assert.equal(view.container.querySelector(".pkg-harnesses-detail"), null);
  } finally {
    await view.unmount();
  }
});

test("projection helpers distinguish remote denial, explicit unsupported, and missing metadata", () => {
  const base = richCodex("helpers");
  const facts = projectionFacts({ ...base, context: { ...base.context, remote: true }, capabilitySupport: {
    harnessId: "codex",
    kinds: {
      tool: { modes: ["native"], remote: false, mutability: "immediate" },
      skill: { modes: ["unsupported"], mutability: "immutable" },
    },
  } });
  assert.equal(facts.find((fact) => fact.id === "tool")?.value, "Unsupported");
  assert.equal(facts.find((fact) => fact.id === "skill")?.value, "Unsupported");
  assert.equal(facts.find((fact) => fact.id === "instruction")?.value, "Not verified");
  assert.match(facts.find((fact) => fact.id === "tool")?.description ?? "", /remote execution target/);
  assert.deepEqual(configurationSections([
    { id: "z", order: 20, meta: { harnessId: "codex", sectionId: "z", label: "Z" } },
    { id: "a", order: 10, meta: { harnessId: "codex", sectionId: "a", label: "A" } },
    { id: "other", order: 0, meta: { harnessId: "cursor", sectionId: "other" } },
  ], "codex"), [{ id: "a", label: "A", order: 10 }, { id: "z", label: "Z", order: 20 }]);
});

test("projection facts preserve every delivery mode and mutability label", () => {
  const cases: Array<{ mode: CapabilityProjectionMode; value: string; mutability: CapabilityMutability; application?: string }> = [
    { mode: "native", value: "Native", mutability: "immediate", application: "Immediate" },
    { mode: "config", value: "Config", mutability: "session-create", application: "New session" },
    { mode: "mcp", value: "via MCP", mutability: "requires-restart", application: "Runtime restart" },
    { mode: "prompt", value: "Prompt", mutability: "immutable", application: "Not editable" },
    { mode: "filesystem", value: "Filesystem", mutability: "immediate", application: "Immediate" },
    { mode: "emulated", value: "Emulated", mutability: "session-create", application: "New session" },
    { mode: "unsupported", value: "Unsupported", mutability: "immutable" },
  ];
  for (const item of cases) {
    const facts = projectionFacts({ ...richCodex("projection-modes"), capabilitySupport: {
      harnessId: "codex",
      kinds: { instruction: { modes: [item.mode], mutability: item.mutability, configScope: "project" } },
    } });
    const instruction = facts.find((fact) => fact.id === "instruction");
    assert.equal(instruction?.value, item.value, `${item.mode} label`);
    assert.equal(instruction?.application, item.application, `${item.mode} mutability`);
    assert.equal(instruction?.unsupported, item.mode === "unsupported", `${item.mode} support state`);
  }
});
