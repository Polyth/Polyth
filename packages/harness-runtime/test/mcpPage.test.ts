import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import type { HarnessCapabilityStatusDto } from "@polyth/contracts";
import type { McpInspectionDto, McpInstallationDto } from "@polyth/contracts/capability-installations";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  },
  cancelAnimationFrame: () => {},
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type RequestRecord = { method: string; path: string; body?: unknown; signal?: AbortSignal | null };
const requests: RequestRecord[] = [];
let servers: McpInstallationDto[] = [];
let capabilities: HarnessCapabilityStatusDto[] = [];
let probeResult: McpInspectionDto = { ok: true, message: "ok", checkedAt: 1, tools: [] };
let probeHold: Promise<McpInspectionDto> | undefined;
let imported: unknown;
let respond: ((request: RequestRecord) => Promise<Response> | undefined) | undefined;
// Undefined answers 404, like a server from before MCP ownership.
let access: { canManageSpace: boolean; canManagePersonal: boolean } | undefined;
let personalServers: McpInstallationDto[] = [];

globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), "http://localhost:3000");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
  const request = { method, path: `${url.pathname}${url.search}`, body, signal: init?.signal };
  requests.push(request);
  const pending = respond?.(request);
  if (pending) return pending;
  if (url.pathname === "/api/mcp/servers" && method === "GET") {
    const project = url.searchParams.get("projectId");
    return new Response(JSON.stringify(servers.filter((row) => row.projectId === undefined || row.projectId === project)));
  }
  if (url.pathname === "/api/mcp/servers" && method === "POST") {
    const projectId = url.searchParams.get("projectId") ?? undefined;
    return new Response(JSON.stringify({
      id: "created",
      name: (body as { name: string }).name,
      transport: (body as { transport: McpInstallationDto["transport"] }).transport,
      enabled: true,
      status: "starting",
      revision: 1,
      scope: projectId ? "project" : "space",
      ...(projectId ? { projectId } : {}),
    } satisfies McpInstallationDto));
  }
  if (url.pathname === "/api/mcp/servers/import" && method === "POST") {
    imported = body;
    return new Response(JSON.stringify([]));
  }
  const override = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/override$/);
  if (override && method === "POST") {
    return new Response(JSON.stringify({
      id: "override-1",
      name: "inherited",
      transport: { kind: "http", url: "https://space.test/mcp", headersSecretRefs: [] },
      enabled: (body as { enabled: boolean }).enabled,
      status: "starting",
      revision: 1,
      scope: "project",
      projectId: url.searchParams.get("projectId") ?? "p1",
    } satisfies McpInstallationDto));
  }
  const probe = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/probe$/);
  if (probe && method === "POST") {
    const result = probeHold ? await probeHold : probeResult;
    servers = servers.map((row) => row.id === probe[1] ? { ...row, inspection: result, status: result.ok ? "connected" : "error" } : row);
    return new Response(JSON.stringify(result));
  }
  const tools = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/tools$/);
  if (tools && method === "GET") {
    return new Response(JSON.stringify(servers.find((row) => row.id === tools[1])?.inspection ?? {
      ok: false,
      message: "Tools have not been checked",
      checkedAt: 0,
      tools: [],
    }));
  }
  if (url.pathname === "/api/harnesses/capabilities") {
    return new Response(JSON.stringify(capabilities));
  }
  if (url.pathname === "/api/mcp/access" && access) return new Response(JSON.stringify(access));
  if (url.pathname === "/api/mcp/personal/servers" && method === "GET") return new Response(JSON.stringify(personalServers));
  if (url.pathname === "/api/mcp/personal/servers" && method === "POST") {
    return new Response(JSON.stringify({
      id: "mine-created", name: (body as { name: string }).name,
      transport: (body as { transport: McpInstallationDto["transport"] }).transport,
      enabled: true, status: "starting", revision: 1, scope: "person", owner: "person", canManage: true,
    } satisfies McpInstallationDto));
  }
  return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { beginProjectListRequest, publishProjectList, failProjectList, activateProject, getState } = await import("../../../apps/web/src/store.ts");
const { resolveAlert } = await import("../../../apps/web/src/alerts.ts");
const { default: McpPage } = await import("../widgets/McpPage.tsx");

const flush = async (rounds = 8) => {
  for (let index = 0; index < rounds; index++) await act(async () => { await Promise.resolve(); });
};

const labeledButton = (root: ParentNode, label: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll("button")].find((item) =>
    (item.querySelector(".ui-btn-label")?.textContent ?? item.textContent)?.trim() === label);

const click = async (root: ParentNode, label: string) => {
  const button = labeledButton(root, label);
  assert.ok(button, `missing button ${label}`);
  assert.equal(button!.disabled, false, `${label} is disabled`);
  await act(async () => { button!.click(); });
  await flush();
};

const typeInto = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = input.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const server = (over: Partial<McpInstallationDto> = {}): McpInstallationDto => ({
  id: "srv-1",
  name: "docs",
  transport: { kind: "stdio", command: "npx", args: ["-y", "docs"], envKeys: ["TOKEN"] },
  enabled: true,
  status: "starting",
  revision: 1,
  scope: "project",
  projectId: "p1",
  ...over,
});

const mount = async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(McpPage)); });
  await flush();
  return {
    container,
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
};

const seedProjects = () => {
  publishProjectList(beginProjectListRequest(), [
    { id: "p1", name: "Alpha", path: "/alpha", createdAt: 1, spaceId: "space-1" },
    { id: "p2", name: "Beta", path: "/beta", createdAt: 2, spaceId: "space-1" },
    { id: "p3", name: "Other space", path: "/other", createdAt: 3, spaceId: "space-2" },
  ]);
  activateProject("p1");
};

const pick = async (selector: string, label: string) => {
  const trigger = document.querySelector<HTMLButtonElement>(selector);
  assert.ok(trigger, `missing picker ${selector}`);
  await act(async () => { trigger.click(); });
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((item) => item.textContent?.includes(label));
  assert.ok(option, `missing picker option ${label}`);
  await act(async () => { option.click(); });
  await flush();
};
const pickProject = (label: string) => pick('[aria-label="Project in this Space"]', label);
const pickScope = async (scope: "space" | "project") => {
  const option = document.querySelector<HTMLButtonElement>(`.pkg-mcp-scope [data-mcp-scope="${scope}"]`);
  assert.ok(option, `missing scope ${scope}`);
  await act(async () => { option.click(); });
  await flush();
  assert.equal(option.getAttribute("aria-checked"), "true");
};
const rowSwitch = (root: ParentNode, id: string): HTMLButtonElement => {
  const control = root.querySelector<HTMLButtonElement>(`[data-mcp-server="${id}"] [role="switch"]`);
  assert.ok(control, `missing enable switch for ${id}`);
  return control;
};
const toggleRow = async (root: ParentNode, id: string) => {
  const control = rowSwitch(root, id);
  assert.equal(control.disabled, false, `${id} switch is disabled`);
  await act(async () => { control.click(); });
  await flush();
};
const deferredResponse = (status = 200) => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve: (value: unknown) => resolve(new Response(JSON.stringify(value), { status })) };
};

test("loading and failed project discovery never fall back to Space management", async () => {
  requests.length = 0;
  const ticket = beginProjectListRequest();
  const view = await mount();
  try {
    assert.match(view.container.textContent ?? "", /Loading projects/);
    assert.equal(labeledButton(view.container, "Install MCP"), undefined);
    assert.equal(view.container.querySelector<HTMLButtonElement>('[aria-label="Project in this Space"]')!.disabled, true);
    await pickScope("space");
    assert.equal(requests.length, 0);
    await act(async () => { failProjectList(ticket, "project-discovery-failed"); });
    await flush();
    assert.match(view.container.textContent ?? "", /Projects could not be loaded/);
    assert.match(view.container.textContent ?? "", /project-discovery-failed/);
    assert.equal(labeledButton(view.container, "Install MCP"), undefined);
    assert.equal(requests.length, 0);
  } finally {
    await view.unmount();
  }
});

test("MCP uses the searchable shared project picker without navigating the workspace", async () => {
  requests.length = 0;
  seedProjects();
  servers = [server(), server({ id: "beta", name: "beta-server", projectId: "p2" })];
  const view = await mount();
  try {
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[aria-label="Project in this Space"]')!.click(); });
    const options = [...document.querySelectorAll('[role="option"]')];
    assert.equal(options.length, 2);
    assert.equal(options.some((option) => option.textContent?.includes("Other space")), false);
    const search = document.querySelector<HTMLInputElement>('[role="combobox"]');
    assert.ok(search, "project picker must have search");
    await typeInto(search, "/beta");
    const hits = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.textContent ?? "", /Beta/);
    await act(async () => { hits[0]!.click(); });
    await flush();
    assert.equal(getState().activeProjectId, "p1");
    assert.match(view.container.querySelector('[aria-label="Project in this Space"]')?.textContent ?? "", /Beta/);
    assert.match(view.container.textContent ?? "", /beta-server/);
    assert.equal(view.container.querySelector('[data-mcp-server="srv-1"]'), null);
    assert.ok(requests.some((request) => request.path === "/api/mcp/servers?projectId=p2"));
  } finally {
    await view.unmount();
  }
});

test("returning to a project cannot revive an earlier probe or clear a newer busy state", async () => {
  requests.length = 0;
  seedProjects();
  servers = [server()];
  const old = deferredResponse(), current = deferredResponse();
  let probes = 0;
  respond = (request) => request.path.endsWith("/probe?projectId=p1")
    ? (++probes === 1 ? old.promise : current.promise) : undefined;
  const view = await mount();
  try {
    await click(view.container, "Check tools");
    await pickProject("Beta");
    await pickProject("Alpha");
    await click(view.container, "Check tools");
    const requestCount = requests.length;
    old.resolve({ ok: true, message: "old", checkedAt: 1, tools: [{ name: "old-tool", inputSchema: {} }] });
    await flush();
    assert.equal(requests.length, requestCount, "the retired probe must not refresh the new selection");
    assert.equal(labeledButton(view.container, "Check tools")!.disabled, true);
    assert.equal((view.container.textContent ?? "").includes("old-tool"), false);
    current.resolve({ ok: false, message: "current-result", checkedAt: 2, tools: [] });
    await flush();
    assert.equal(labeledButton(view.container, "Check tools")!.disabled, false);
  } finally {
    respond = undefined;
    old.resolve({ ok: false, tools: [], checkedAt: 0, message: "cleanup" });
    current.resolve({ ok: false, tools: [], checkedAt: 0, message: "cleanup" });
    await view.unmount();
  }
});

test("switching Space never requests the previous Space's selected project", async () => {
  requests.length = 0;
  seedProjects();
  servers = [server(), server({ id: "foreign", name: "space-two-server", projectId: "p3" })];
  const view = await mount();
  try {
    await pickProject("Beta");
    const before = requests.length;
    await act(async () => { activateProject("p3"); });
    await flush();
    assert.equal(requests.slice(before).some((request) => /projectId=p[12]$/.test(request.path)), false);
    assert.ok(requests.slice(before).some((request) => request.path === "/api/mcp/servers?projectId=p3"));
    assert.match(view.container.querySelector('[aria-label="Project in this Space"]')?.textContent ?? "", /Other space/);
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[aria-label="Project in this Space"]')!.click(); });
    const options = [...document.querySelectorAll('[role="option"]')];
    assert.equal(options.length, 1);
    assert.match(options[0]!.textContent ?? "", /Other space/);
  } finally {
    await view.unmount();
  }
});

test("a missing active Space never offers projects from ambiguous Spaces", async () => {
  requests.length = 0;
  seedProjects();
  activateProject(null);
  servers = [server()];
  const view = await mount();
  try {
    assert.equal(requests.some((request) => request.path.includes("projectId=")), false);
    assert.equal(labeledButton(view.container, "Install MCP"), undefined);
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[aria-label="Project in this Space"]')!.click(); });
    assert.equal(document.querySelectorAll('[role="option"]').length, 0);
  } finally {
    await view.unmount();
  }
});

test("switching scope discards late tool results and uses Space API paths", async () => {
  requests.length = 0;
  seedProjects();
  servers = [server(), server({ id: "shared", name: "shared", scope: "space", projectId: undefined })];
  const old = deferredResponse();
  respond = (request) => request.path.endsWith("/srv-1/tools?projectId=p1") ? old.promise : undefined;
  const view = await mount();
  try {
    await click(view.container.querySelector('[data-mcp-server="srv-1"]')!, "Show tools");
    await pickScope("space");
    assert.equal(view.container.querySelector('[aria-label="Project in this Space"]'), null);
    assert.ok(requests.some((request) => request.path === "/api/mcp/servers"));
    assert.ok(requests.some((request) => request.path === "/api/harnesses/capabilities"));
    assert.equal(view.container.querySelector('[data-mcp-server="srv-1"]'), null);
    old.resolve({ ok: true, message: "stale", checkedAt: 1, tools: [{ name: "stale-tool", inputSchema: {} }] });
    await flush();
    assert.equal((view.container.textContent ?? "").includes("stale-tool"), false);
    await pickScope("project");
    assert.match(view.container.querySelector('[aria-label="Project in this Space"]')?.textContent ?? "", /Alpha/);
  } finally {
    respond = undefined;
    old.resolve({ ok: false, tools: [], checkedAt: 0, message: "cleanup" });
    await view.unmount();
  }
});

test("an earlier remove confirmation cannot delete after leaving and returning", async () => {
  requests.length = 0;
  seedProjects();
  servers = [server()];
  const view = await mount();
  try {
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[aria-label="Remove docs"]')!.click(); });
    await pickProject("Beta");
    await pickProject("Alpha");
    await act(async () => { resolveAlert(true); });
    await flush();
    assert.equal(requests.some((request) => request.method === "DELETE"), false);
  } finally {
    await act(async () => { resolveAlert(false); });
    await view.unmount();
  }
});

test("a single Space can resolve project selection before workspace navigation", async () => {
  requests.length = 0;
  publishProjectList(beginProjectListRequest(), [{ id: "local", name: "", path: "/local project", createdAt: 1 }]);
  activateProject(null);
  servers = [];
  const view = await mount();
  try {
    assert.ok(requests.some((request) => request.path === "/api/mcp/servers?projectId=local"));
    assert.match(view.container.querySelector('[aria-label="Project in this Space"]')?.textContent ?? "", /\/local project/);
    assert.ok(labeledButton(view.container, "Install MCP"));
    assert.equal(getState().activeProjectId, null);
  } finally {
    await view.unmount();
  }
});

test("late list and harness responses are aborted and cannot replace the returned project's view", async () => {
  requests.length = 0;
  seedProjects();
  servers = [server({ name: "current-server" })];
  capabilities = [{ harnessId: "current-harness", desiredRevision: "1", records: [{
    capabilityId: "mcp.current", kind: "mcp-server", owner: "polyth", desiredRevision: "1", mode: "mcp", status: "pending",
  }] }];
  const oldList = deferredResponse(), oldHarness = deferredResponse();
  let lists = 0, harnesses = 0;
  respond = (request) => {
    if (request.path === "/api/mcp/servers?projectId=p1" && ++lists === 1) return oldList.promise;
    if (request.path === "/api/harnesses/capabilities?projectId=p1" && ++harnesses === 1) return oldHarness.promise;
    return undefined;
  };
  const view = await mount();
  try {
    // What the caller may manage is per Space; switching projects keeps it.
    const initial = requests.filter((request) => request.path !== "/api/mcp/access");
    await pickProject("Beta");
    assert.equal(initial.every((request) => request.signal?.aborted), true);
    await pickProject("Alpha");
    oldList.resolve([server({ name: "obsolete-server" })]);
    oldHarness.resolve([{ ...capabilities[0], harnessId: "obsolete-harness" }]);
    await flush();
    assert.match(view.container.textContent ?? "", /current-server/);
    // Provisioning rows show the harness display name ("current-harness" → "Current Harness").
    assert.match(view.container.textContent ?? "", /Current Harness/);
    assert.doesNotMatch(view.container.textContent ?? "", /obsolete/i);
  } finally {
    respond = undefined;
    oldList.resolve([]);
    oldHarness.resolve([]);
    await view.unmount();
  }
});

test("a pending installation cannot close a new form or replay after returning", async () => {
  requests.length = 0;
  seedProjects();
  servers = [];
  const old = deferredResponse();
  respond = (request) => request.method === "POST" && request.path === "/api/mcp/servers?projectId=p1" ? old.promise : undefined;
  const view = await mount();
  try {
    await click(view.container, "Install MCP");
    await typeInto(view.container.querySelector<HTMLInputElement>('[aria-label="Server name"]')!, "first");
    await typeInto(view.container.querySelector<HTMLInputElement>('[aria-label="Server URL"]')!, "https://fixture.test/mcp");
    await click(view.container, "Add server");
    await pickProject("Beta");
    await pickProject("Alpha");
    await click(view.container, "Install MCP");
    await typeInto(view.container.querySelector<HTMLInputElement>('[aria-label="Server name"]')!, "new-form");
    const count = requests.length;
    old.resolve(server({ name: "first" }));
    await flush();
    assert.equal(requests.length, count);
    assert.equal(view.container.querySelector<HTMLInputElement>('[aria-label="Server name"]')!.value, "new-form");
    assert.equal(requests.filter((request) => request.method === "POST").length, 1);
  } finally {
    respond = undefined;
    old.resolve({});
    await view.unmount();
  }
});

test("cached tool loading admits one request and blocks a competing probe", async () => {
  requests.length = 0;
  seedProjects();
  servers = [server()];
  const tools = deferredResponse();
  respond = (request) => request.path.endsWith("/tools?projectId=p1") ? tools.promise : undefined;
  const view = await mount();
  try {
    const button = labeledButton(view.container, "Show tools")!;
    await act(async () => { button.click(); button.click(); });
    await flush();
    assert.equal(requests.filter((request) => request.path.includes("/tools?")).length, 1);
    assert.equal(labeledButton(view.container, "Check tools")!.disabled, true);
    tools.resolve({ ok: true, message: "cached", checkedAt: 1, tools: [{ name: "cached-tool", inputSchema: {} }] });
    await flush();
    assert.match(view.container.textContent ?? "", /cached-tool/);
    assert.equal(labeledButton(view.container, "Check tools")!.disabled, false);
    assert.equal(requests.some((request) => request.path.includes("/probe")), false);
  } finally {
    respond = undefined;
    tools.resolve({});
    await view.unmount();
  }
});

for (const status of [200, 503]) {
  test(`a superseded list response (${status}) cannot publish rows or errors in the same visit`, async () => {
    requests.length = 0;
    seedProjects();
    servers = [server(), server({ id: "second", name: "second" })];
    const view = await mount();
    const old = deferredResponse(status);
    let lists = 0;
    respond = (request) => {
      if (request.method === "PATCH") return Promise.resolve(new Response(JSON.stringify(server())));
      if (request.method === "GET" && request.path === "/api/mcp/servers?projectId=p1" && ++lists === 1) return old.promise;
      return undefined;
    };
    try {
      await toggleRow(view.container, "srv-1");
      servers = servers.map((row) => ({ ...row, name: `fresh-${row.name}`, enabled: false, status: "disabled" }));
      await toggleRow(view.container, "second");
      assert.match(view.container.textContent ?? "", /fresh-docs/);
      old.resolve(status === 200 ? [server({ name: "obsolete-request" })] : { message: "obsolete-request" });
      await flush();
      assert.match(view.container.textContent ?? "", /fresh-docs/);
      assert.doesNotMatch(view.container.textContent ?? "", /obsolete-request/);
    } finally {
      respond = undefined;
      old.resolve([]);
      await view.unmount();
    }
  });
}

test("shows Not checked, Space project picker, and inherited override actions", async () => {
  requests.length = 0;
  seedProjects();
  servers = [
    server(),
    {
      id: "space-1",
      name: "inherited",
      transport: { kind: "http", url: "https://space.test/mcp", headersSecretRefs: ["Authorization"] },
      enabled: true,
      status: "starting",
      revision: 2,
      scope: "space",
    },
  ];
  capabilities = [{
    harnessId: "codex",
    desiredRevision: "1",
    records: [{
      capabilityId: "mcp.docs",
      kind: "mcp-server",
      owner: "polyth",
      desiredRevision: "1",
      mode: "mcp",
      status: "pending",
    }],
  }];
  const view = await mount();
  try {
    const text = view.container.textContent ?? "";
    assert.match(text, /Not checked/);
    assert.match(text, /Inherited from Global/);
    assert.match(text, /Project servers/);
    assert.ok(view.container.querySelector('[data-mcp-server="space-1"] [role="switch"][aria-label="Turn off inherited for this project"]'));
    assert.ok(view.container.querySelector('[data-mcp-server="srv-1"] [role="switch"][aria-label="Disable docs"]'));
    assert.match(text, /Customize/);
    assert.match(text, /Check tools starts the configured MCP command/);
    assert.match(text, /does not call them/);
    assert.match(text, /not proof that a tool was invoked/);
    assert.match(text, /next supported turn/);
    assert.equal(text.includes("pat-secret"), false);
    assert.ok(requests.some((item) => item.path.startsWith("/api/mcp/servers?projectId=p1")));
    assert.ok(requests.some((item) => item.path.startsWith("/api/harnesses/capabilities?projectId=p1")));
  } finally {
    await view.unmount();
  }
});

test("Check tools posts probe once and renders cached schema details", async () => {
  requests.length = 0;
  seedProjects();
  probeResult = {
    ok: true,
    message: "ok",
    checkedAt: 1_700_000_000_000,
    tools: [{ name: "search", description: "Find files", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
    serverInfo: { name: "docs", version: "1" },
  };
  servers = [server()];
  const view = await mount();
  try {
    assert.match(view.container.textContent ?? "", /Not checked/);
    const check = labeledButton(view.container, "Check tools");
    assert.ok(check, "missing Check tools");
    assert.equal(check!.getAttribute("data-settings-item"), "mcp.check");
    assert.equal(check!.getAttribute("title"), "Check tools");
    await act(async () => { check!.click(); check!.click(); });
    await flush();
    const probes = requests.filter((item) => item.path.includes("/probe"));
    assert.equal(probes.length, 1, JSON.stringify(requests));
    assert.match(view.container.textContent ?? "", /Tools: 1/);
    await click(view.container, "search");
    assert.match(view.container.textContent ?? "", /"q"/);
  } finally {
    await view.unmount();
  }
});

test("stale project changes do not apply an in-flight probe", async () => {
  requests.length = 0;
  seedProjects();
  servers = [server()];
  let release: ((value: McpInspectionDto) => void) | undefined;
  probeHold = new Promise((resolve) => { release = resolve; });
  const view = await mount();
  try {
    const probeButton = [...view.container.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Check tools");
    await act(async () => { probeButton?.click(); });
    await flush(2);
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[aria-label="Project in this Space"]')!.click(); });
    const beta = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("Beta"));
    assert.ok(beta, "project picker must offer Beta");
    await act(async () => { beta!.click(); });
    await flush();
    assert.ok(requests.some((item) => item.path === "/api/mcp/servers?projectId=p2"));
    release?.({
      ok: true,
      message: "late",
      checkedAt: 9,
      tools: [{ name: "late-tool", inputSchema: {} }],
    });
    await flush();
    assert.equal((view.container.textContent ?? "").includes("late-tool"), false);
  } finally {
    probeHold = undefined;
    await view.unmount();
  }
});

test("install panel posts JSON args with spaces and atomic import without previewing secrets", async () => {
  requests.length = 0;
  imported = undefined;
  seedProjects();
  servers = [];
  const view = await mount();
  try {
    await click(view.container, "Install MCP");
    await click(view.container, "Local command");
    const inputs = [...view.container.querySelectorAll("input")];
    const name = inputs.find((item) => item.getAttribute("aria-label") === "Server name");
    const command = inputs.find((item) => item.getAttribute("aria-label") === "Command");
    const args = inputs.find((item) => item.getAttribute("aria-label") === "Arguments JSON array");
    assert.ok(name && command && args);
    await typeInto(name!, "local-docs");
    await typeInto(command!, "npx");
    await typeInto(args!, '["-y","server","path with spaces"]');
    await click(view.container, "Add server");
    const created = requests.find((item) => item.method === "POST" && item.path.startsWith("/api/mcp/servers?"));
    assert.deepEqual((created?.body as { transport: { args: string[] } }).transport.args, ["-y", "server", "path with spaces"]);

    await click(view.container, "Install MCP");
    await click(view.container, "JSON import");
    const textarea = view.container.querySelector("textarea");
    assert.ok(textarea);
    await typeInto(textarea!, JSON.stringify({
      mcp_servers: {
        imported: { command: "npx", args: ["tool"], env: { TOKEN: "super-secret-value" } },
      },
    }));
    await click(view.container, "Preview");
    const preview = view.container.querySelector(".pkg-mcp-preview")?.textContent ?? "";
    assert.equal(preview.includes("super-secret-value"), false);
    assert.match(preview, /Secrets: TOKEN/);
    await click(view.container, "Import servers (1)");
    assert.deepEqual(imported, {
      servers: [{
        name: "imported",
        transport: { kind: "stdio", command: "npx", args: ["tool"], envKeys: ["TOKEN"] },
        secrets: { TOKEN: "super-secret-value" },
      }],
    });
  } finally {
    await view.unmount();
  }
});

test("inherited Disable copies through override and cancel clears secret fields", async () => {
  requests.length = 0;
  seedProjects();
  servers = [{
    id: "space-1",
    name: "inherited",
    transport: { kind: "http", url: "https://space.test/mcp", headersSecretRefs: [] },
    enabled: true,
    status: "starting",
    revision: 2,
    scope: "space",
  }];
  const view = await mount();
  try {
    const row = view.container.querySelector('[data-mcp-server="space-1"]');
    assert.ok(row);
    const disable = rowSwitch(row!, "space-1");
    assert.equal(disable.getAttribute("aria-checked"), "true");
    assert.ok(disable, row!.innerHTML);
    assert.equal(disable!.disabled, false, disable!.outerHTML);
    await act(async () => { disable!.click(); });
    await flush();
    const override = requests.find((item) => item.path.includes("/override"));
    assert.equal(override?.method, "POST", JSON.stringify(requests));
    assert.deepEqual(override?.body, { enabled: false });
    assert.match(override?.path ?? "", /projectId=p1/);

    await click(view.container, "Install MCP");
    await click(view.container, "Add secret");
    const secret = [...view.container.querySelectorAll("input")].find((item) => item.getAttribute("aria-label") === "Secret value");
    assert.ok(secret);
    await typeInto(secret!, "typed-secret");
    await click(view.container, "Cancel");
    assert.equal(view.container.querySelector("[data-settings-item=\"mcp.install\"]"), null);
  } finally {
    await view.unmount();
  }
});

test("remove confirmation can complete without leaking secrets into the page", async () => {
  requests.length = 0;
  seedProjects();
  servers = [server({ lastError: "failed" })];
  const view = await mount();
  try {
    const remove = view.container.querySelector<HTMLButtonElement>('[aria-label="Remove docs"]') ?? undefined;
    assert.ok(remove);
    assert.equal(remove!.disabled, false, remove!.outerHTML);
    await act(async () => { remove!.click(); });
    await act(async () => { resolveAlert(true); });
    await flush();
    assert.ok(
      requests.some((item) => item.method === "DELETE" && item.path.includes("/api/mcp/servers/srv-1")),
      JSON.stringify(requests),
    );
    assert.equal((view.container.textContent ?? "").includes("typed-secret"), false);
  } finally {
    await view.unmount();
  }
});

test("project view marks Global shadows and Customize opens the new project copy", async () => {
  requests.length = 0;
  seedProjects();
  const globalDocs: McpInstallationDto = {
    id: "space-docs",
    name: "docs",
    transport: { kind: "http", url: "https://space.test/docs", headersSecretRefs: [] },
    enabled: true,
    status: "starting",
    revision: 1,
    scope: "space",
  };
  const globalSearch: McpInstallationDto = { ...globalDocs, id: "space-search", name: "search", transport: { kind: "http", url: "https://space.test/search", headersSecretRefs: [] } };
  const projectDocs = server();
  // The fixture GET returns Space rows for the Global read and both for the
  // project read; model the effective set the real service returns instead.
  respond = (request) => {
    if (request.method === "GET" && request.path === "/api/mcp/servers") {
      return Promise.resolve(new Response(JSON.stringify(servers.filter((row) => row.scope === "space"))));
    }
    if (request.method === "GET" && request.path === "/api/mcp/servers?projectId=p1") {
      const own = servers.filter((row) => row.projectId === "p1");
      const names = new Set(own.map((row) => row.name));
      return Promise.resolve(new Response(JSON.stringify([...own, ...servers.filter((row) => row.scope === "space" && !names.has(row.name))])));
    }
    if (request.method === "POST" && request.path.startsWith("/api/mcp/servers/space-search/override")) {
      const copy: McpInstallationDto = { ...globalSearch, id: "search-copy", scope: "project", projectId: "p1" };
      servers = [...servers, copy];
      return Promise.resolve(new Response(JSON.stringify(copy)));
    }
    return undefined;
  };
  servers = [globalDocs, globalSearch, projectDocs];
  const view = await mount();
  try {
    const docs = view.container.querySelector('[data-mcp-server="srv-1"]');
    assert.ok(docs);
    assert.match(docs!.textContent ?? "", /Overrides Global/);
    assert.ok(!view.container.querySelector('[data-mcp-server="space-docs"]'));
    const inherited = view.container.querySelector('[data-mcp-server="space-search"]');
    assert.ok(inherited);
    assert.doesNotMatch(inherited!.textContent ?? "", /Overrides Global/);
    assert.match(view.container.querySelector('[data-mcp-scope="space"]')?.textContent ?? "", /2/);

    await click(inherited!, "Customize");
    const override = requests.find((item) => item.path.includes("/override"));
    assert.deepEqual(override?.body, { enabled: true });
    const editor = view.container.querySelector<HTMLFormElement>('form[aria-label="Edit search"]');
    assert.ok(editor, "Customize should open the editor for the project copy");
    assert.equal(editor!.querySelector<HTMLInputElement>('[aria-label="Server name"]')!.value, "search");
  } finally {
    respond = undefined;
    await view.unmount();
  }
});

test("empty scope offers quick-start installs that preselect the transport", async () => {
  requests.length = 0;
  seedProjects();
  servers = [];
  const view = await mount();
  try {
    assert.match(view.container.textContent ?? "", /No MCP servers for this project/);
    await click(view.container, "Add local command");
    const panel = view.container.querySelector('[data-settings-item="mcp.install"]');
    assert.ok(panel);
    assert.match(panel!.textContent ?? "", /Installing into Project · Alpha/);
    assert.ok(panel!.querySelector('[aria-label="Command"]'));
    assert.ok(!panel!.querySelector('[aria-label="Server URL"]'));
    assert.ok(!labeledButton(view.container, "Install MCP"));

    await click(view.container, "Cancel");
    await pickScope("space");
    assert.match(view.container.textContent ?? "", /No Global MCP servers/);
    await click(view.container, "Import JSON");
    assert.ok(view.container.querySelector('[aria-label="MCP import JSON"]'));
    assert.equal(requests.some((item) => item.path.includes("projectId=") && item.method !== "GET"), false);
  } finally {
    await view.unmount();
  }
});

test("a member sees Space servers read-only: no install, edit, switch or check", async () => {
  requests.length = 0;
  seedProjects();
  access = { canManageSpace: false, canManagePersonal: true };
  servers = [server({
    id: "space-docs", scope: "space", projectId: undefined, owner: "space", canManage: false, redacted: true,
    transport: { kind: "http", url: "https://docs.example/", headersSecretRefs: ["Authorization"] },
  })];
  const view = await mount();
  try {
    await pickScope("space");
    const row = view.container.querySelector('[data-mcp-server="space-docs"]');
    assert.ok(row, "the member still sees the Space server");
    assert.equal(labeledButton(view.container, "Install MCP"), undefined);
    assert.equal(row!.querySelector('[role="switch"]'), null);
    assert.equal(labeledButton(row!, "Check tools"), undefined);
    assert.equal(row!.querySelector('[aria-label="Edit docs"]'), null);
    assert.equal(row!.querySelector('[aria-label="Remove docs"]'), null);
    assert.ok(labeledButton(row!, "Show tools"));
    assert.ok(view.container.querySelector('[data-mcp-readonly="true"]'));
    assert.ok(view.container.querySelector('[data-mcp-scope="person"]'), "members may keep their own servers");
  } finally {
    access = undefined;
    await view.unmount();
  }
});

test("the Yours tab lists and installs personal servers on the personal routes, without JSON import", async () => {
  requests.length = 0;
  seedProjects();
  access = { canManageSpace: false, canManagePersonal: true };
  servers = [];
  personalServers = [server({ id: "mine", name: "notes", scope: "person", projectId: undefined, owner: "person", canManage: true })];
  const view = await mount();
  try {
    const option = view.container.querySelector<HTMLButtonElement>('[data-mcp-scope="person"]');
    assert.ok(option);
    await act(async () => { option!.click(); });
    await flush();
    assert.ok(requests.some((request) => request.method === "GET" && request.path === "/api/mcp/personal/servers"));
    const row = view.container.querySelector('[data-mcp-server="mine"]');
    assert.ok(row);
    assert.match(row!.textContent ?? "", /Only you/);
    assert.ok(row!.querySelector('[aria-label="Edit notes"]'), "the owner manages their own server");
    assert.ok(labeledButton(row!, "Check tools"));
    await click(view.container, "Install MCP");
    assert.equal(labeledButton(view.container, "JSON import"), undefined);
    await typeInto(view.container.querySelector<HTMLInputElement>('[aria-label="Server name"]')!, "calendar");
    await typeInto(view.container.querySelector<HTMLInputElement>('[aria-label="Server URL"]')!, "https://cal.example/mcp");
    await click(view.container, "Add server");
    const created = requests.find((request) => request.method === "POST" && request.path.startsWith("/api/mcp/"));
    assert.equal(created?.path, "/api/mcp/personal/servers");
  } finally {
    access = undefined;
    personalServers = [];
    await view.unmount();
  }
});
