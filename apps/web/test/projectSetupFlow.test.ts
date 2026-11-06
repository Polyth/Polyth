import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  CustomEvent: dom.CustomEvent,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  location: dom.location,
  history: dom.history,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
let coarsePointer = false;
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (media: string) => ({ matches: media.includes("coarse") && coarsePointer, media, addEventListener() {}, removeEventListener() {} }),
});

interface Call { method: string; path: string; body: Record<string, unknown> }
const server = {
  calls: [] as Call[],
  projects: [] as Array<Record<string, unknown>>,
  canChooseFolder: true,
  failManagedCreates: 0,
  nextId: 1,
};
const projectId = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(server.nextId++).padStart(12, "0")}`;
const respond = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  statusText: status < 400 ? "OK" : "Error",
  headers: new Headers(),
  json: async () => body,
  text: async () => JSON.stringify(body),
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1:4400");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const path = url.pathname;
    if (method !== "GET") server.calls.push({ method, path, body });
    if (path === "/api/projects/managed") {
      if (method === "GET") return respond({ canChooseFolder: server.canChooseFolder });
      if (server.failManagedCreates > 0) {
        server.failManagedCreates -= 1;
        return respond({ error: "conflict", message: "the disk is full" }, 500);
      }
      const project = { id: projectId(), name: body.name, path: `/data/spaces/home/projects/${server.nextId}`, createdAt: 1, composition: body.composition };
      server.projects.push(project);
      return respond(project);
    }
    if (path === "/api/projects/setup" || (path === "/api/projects" && method === "POST")) {
      const known = server.projects.find((project) => project.path === body.path);
      if (known) return respond(known);
      const project = { id: projectId(), name: String(body.path).split("/").pop(), path: body.path, createdAt: 1, ...(body.composition ? { composition: body.composition } : {}) };
      server.projects.push(project);
      return respond(project);
    }
    if (path === "/api/projects") return respond(server.projects);
    const patch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (patch && method === "PATCH") {
      const project = server.projects.find((candidate) => candidate.id === patch[1])!;
      Object.assign(project, body);
      return respond(project);
    }
    if (path === "/api/browse") return respond({ path: "/home/demo/site", parent: "/home/demo", home: "/home/demo", entries: [] });
    if (path === "/api/packages") return respond({ packages: [] });
    if (path === "/api/iconify") return respond({ icons: [] });
    if (path === "/project-icons.json") return respond([]);
    if (path === "/api/sessions") return respond([]);
    return respond({});
  },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { setNextProjectComposition } = await import("@polyth/session/web-api");
const store = await import("../src/store.ts");
const { default: ProjectSetupFlowDialog } = await import("../src/components/ProjectSetupFlowDialog.tsx");

const flush = async () => {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const has = (selector: string): boolean => document.querySelector(selector) !== null;
const text = (selector: string): string => document.querySelector(selector)?.textContent ?? "";
const click = async (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  assert.ok(element !== null, `missing ${selector}`);
  await act(async () => { element!.click(); });
  await flush();
};
const clickText = async (label: string) => {
  const element = [...document.querySelectorAll<HTMLElement>("button")].find((button) => button.textContent?.trim() === label);
  assert.ok(element !== undefined, `missing button ${label}`);
  await act(async () => { element!.click(); });
  await flush();
};
const typeName = async (value: string) => {
  const input = document.querySelector<HTMLInputElement>(".project-identity-name input")!;
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
};
const nameValue = (): string => document.querySelector<HTMLInputElement>(".project-identity-name input")?.value ?? "";
const CONTINUE = ".project-setup-actions .ui-btn--primary";
const WINDOW = ".project-identity-dialog";
const PICKER = ".folder-dialog";
const directionCard = (index: number) => `.project-direction-card:nth-child(${index})`;
const ENGINEERING = directionCard(2);
const CREATE = ".project-identity-actions .ui-btn--primary";
const writes = (path: string) => server.calls.filter((call) => call.path === path);
const patches = () => server.calls.filter((call) => call.method === "PATCH");

async function mount() {
  const closed = { count: 0 };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(ProjectSetupFlowDialog, { onClose() { closed.count += 1; } })); });
  await flush();
  return { closed, unmount: async () => { await act(async () => { root.unmount(); }); document.body.innerHTML = ""; } };
}

test.beforeEach(() => {
  server.calls = [];
  server.projects = [];
  server.canChooseFolder = true;
  server.failManagedCreates = 0;
  coarsePointer = false;
  setNextProjectComposition(undefined);
});

test("a project that isn't about code needs no folder: the window, then one press", async () => {
  const { closed, unmount } = await mount();
  assert.match(text(".project-setup-step"), /Step 1 of 2/);

  await click(CONTINUE);
  assert.equal(has(PICKER), false, "no file manager");
  assert.equal(has(WINDOW), true);
  assert.match(text(".project-setup-step"), /Step 2 of 2/);
  assert.match(text(".project-identity-folder"), /Polyth folder/);
  assert.equal(nameValue(), "New project", "the default name is ready to accept");
  assert.equal(server.calls.length, 0, "nothing exists before the press");

  await typeName("Trip to Italy");
  await click(".project-color-presets > button:nth-child(4)");
  await click(".project-identity-starters > button:nth-child(6)");
  assert.equal(writes("/api/projects/managed").length, 0);

  await click(CREATE);

  const [create] = writes("/api/projects/managed");
  assert.equal(create!.body.name, "Trip to Italy");
  assert.equal(create!.body.path, undefined, "the server chooses the folder");
  assert.equal(typeof create!.body.clientOperationId, "string");
  assert.deepEqual(create!.body.composition, { version: 1, directions: [], packageOverrides: {} });
  const [patch] = patches();
  assert.equal(patch!.body.color, "#f28c38");
  assert.equal(patch!.body.icon, "/assets/project-icons/plane.svg");
  assert.equal(closed.count, 1);
  assert.equal(store.getState().activeProjectId, server.projects[0]!.id);
  await unmount();
});

test("the name fits the direction, and a direction chooses the icon", async () => {
  const { unmount } = await mount();
  await click(directionCard(6)); // Home
  await click(CONTINUE);
  assert.equal(nameValue(), "Home");
  assert.equal(document.querySelector(".project-identity-starters > button.selected")?.getAttribute("aria-label"), "house");

  // Going back to change direction refreshes defaults, not the person's choices.
  await typeName("My flat");
  await clickText("Back");
  await click(directionCard(5)); // adds Finance
  await click(CONTINUE);
  assert.equal(nameValue(), "My flat");
  await unmount();
});

test("Engineering starts with the folder, and that window can be skipped", async () => {
  const { closed, unmount } = await mount();
  await click(ENGINEERING);
  assert.match(text(".project-setup-step"), /Step 1 of 3/);

  await click(CONTINUE);
  assert.equal(has(PICKER), true, "a repository is the point");
  assert.match(document.body.textContent ?? "", /Step 2 of 3/);

  await click(".folder-foot .ui-btn--primary");
  assert.equal(has(WINDOW), true);
  assert.match(text(".project-setup-step"), /Step 3 of 3/);
  assert.equal(nameValue(), "site", "the name comes from the folder");
  assert.match(text(".project-identity-folder"), /\/home\/demo\/site/);
  assert.equal(document.querySelector(".project-identity-folder button"), null, "nothing left to choose");
  assert.equal(closed.count, 0);

  const appearanceBefore = patches().filter((call) => "color" in call.body).length;
  await clickText("Skip");
  assert.equal(patches().filter((call) => "color" in call.body).length, appearanceBefore, "skipping writes nothing");
  assert.equal(writes("/api/projects/managed").length, 0);
  assert.equal(closed.count, 1);
  await unmount();
});

test("Done saves the look of a project made from a chosen folder", async () => {
  const { closed, unmount } = await mount();
  await click(ENGINEERING);
  await click(CONTINUE);
  await click(".folder-foot .ui-btn--primary");
  await typeName("Site");
  await click(CREATE);
  await flush();
  assert.equal(closed.count, 1);
  const saved = patches().find((call) => "color" in call.body)!;
  assert.equal(saved.body.name, "Site");
  assert.equal(saved.body.icon, "/assets/project-icons/code-xml.svg");
  await unmount();
});

test("Choose another detours through the picker and keeps what was typed", async () => {
  const { unmount } = await mount();
  await click(CONTINUE);
  await typeName("Recipes");

  await clickText("Choose another");
  assert.equal(has(PICKER), true);
  assert.doesNotMatch(document.body.textContent ?? "", /Step \d of \d/, "a detour, not a numbered step");

  await click(".folder-back");
  assert.equal(has(WINDOW), true);
  assert.equal(nameValue(), "Recipes");
  assert.equal(server.calls.length, 0, "going there and back changes nothing");

  await clickText("Choose another");
  await click(".folder-foot .ui-btn--primary");
  assert.equal(has(WINDOW), true);
  assert.equal(nameValue(), "Recipes", "the typed name beats the folder's");
  assert.match(text(".project-identity-folder"), /\/home\/demo\/site/);
  assert.equal(writes("/api/projects/managed").length, 0);
  await unmount();
});

test("a failed create keeps every choice, and a retry can find a project a lost response made", async () => {
  server.failManagedCreates = 1;
  const { closed, unmount } = await mount();
  await click(CONTINUE);
  await typeName("Finance");
  await click(CREATE);

  assert.equal(has(WINDOW), true, "back to the window");
  assert.match(text(".project-identity-error"), /disk is full/);
  assert.equal(nameValue(), "Finance");
  assert.equal(closed.count, 0);

  await click(CREATE);
  const creates = writes("/api/projects/managed");
  assert.equal(creates.length, 2);
  assert.equal(creates[1]!.body.clientOperationId, creates[0]!.body.clientOperationId);
  assert.equal(closed.count, 1);
  await unmount();
});

test("a failed create does not follow the person to a folder they chose", async () => {
  server.failManagedCreates = 1;
  const { unmount } = await mount();
  await click(CONTINUE);
  await click(CREATE);
  assert.match(text(".project-identity-error"), /disk is full/);

  await clickText("Choose another");
  await click(".folder-foot .ui-btn--primary");
  assert.equal(has(WINDOW), true);
  assert.equal(has(".project-identity-error"), false);
  await unmount();
});

test("where no folder can be chosen, nothing offers one", async () => {
  server.canChooseFolder = false;
  const { unmount } = await mount();
  await click(ENGINEERING);
  assert.match(text(".project-setup-step"), /Step 1 of 2/);
  await click(CONTINUE);
  assert.equal(has(PICKER), false, "not even for Engineering");
  assert.equal(has(WINDOW), true);
  assert.equal(document.querySelector(".project-identity-folder button"), null);
  await unmount();
});

test("opening a folder that already is a project just goes there", async () => {
  const existing = { id: projectId(), name: "Site", path: "/home/demo/site", createdAt: 1, color: "#65b955" };
  server.projects.push(existing);
  await act(async () => { store.applyProjectAdded(existing as never); });
  const { closed, unmount } = await mount();
  await click(ENGINEERING);
  await click(CONTINUE);
  await click(".folder-foot .ui-btn--primary");
  assert.equal(has(WINDOW), false, "it already has a name, a colour and an icon");
  assert.equal(closed.count, 1);
  await unmount();
});

test("a phone opens the window without a keyboard; a desktop selects the name", async () => {
  coarsePointer = true;
  const phone = await mount();
  await click(CONTINUE);
  assert.equal(document.activeElement === document.querySelector(".project-identity-heading"), true);
  assert.equal(document.activeElement?.tagName === "INPUT", false);
  await phone.unmount();

  coarsePointer = false;
  const desktop = await mount();
  await click(CONTINUE);
  assert.equal(document.activeElement === document.querySelector(".project-identity-name input"), true);
  await desktop.unmount();
});

test("an empty name cannot be submitted", async () => {
  const { unmount } = await mount();
  await click(CONTINUE);
  await typeName("   ");
  assert.equal(document.querySelector<HTMLButtonElement>(CREATE)?.disabled, true);
  await unmount();
});
