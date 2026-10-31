// Settings → Harnesses → Install: a person who has never opened a terminal
// installs a harness in the background, sees honest progress, and is led to
// sign in; the exact command and live output stay one disclosure away.
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import type { HarnessInstallDto, HarnessInstallPreviewDto, HarnessSnapshot } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
  cancelAnimationFrame: () => {},
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { en } = await import("../src/i18n/en.ts");
const translate = (key: string, values: Record<string, string | number> = {}) =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));

type Request = { method: string; path: string; body?: unknown };
const requests: Request[] = [];
let snapshots: HarnessSnapshot[] = [];
let jobs: HarnessInstallDto[] = [];
let readFailure: { status: number; error: string } | undefined;
let nextJob: HarnessInstallDto | undefined;

const preview: HarnessInstallPreviewDto = {
  harnessId: "antigravity", harnessName: "Antigravity", target: "local", machine: { kind: "local", os: "darwin" },
  command: "curl -fsSL https://antigravity.google/cli/install.sh | bash", sources: ["antigravity.google"], browserOnMachine: true,
  setupUrl: "https://antigravity.google/docs/cli/install/",
};
const job = (over: Partial<HarnessInstallDto>): HarnessInstallDto => ({ ...preview, id: "job-1", phase: "running", startedAt: Date.now(), output: "", ...over });

globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), "http://localhost:3000");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
  requests.push({ method, path: `${url.pathname}${url.search}`, body });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  if (url.pathname === "/api/harnesses/roster") return json(snapshots.map((row) => ({ identity: row.identity, policy: row.policy })));
  if (url.pathname === "/api/harnesses/access") return json({ manage: true, personal: true });
  if (url.pathname === "/api/harnesses/default") return json({ harnessId: null, usable: false });
  if (url.pathname === "/api/harnesses/updates") return json([]);
  if (url.pathname === "/api/harnesses/installs") return json(jobs);
  if (url.pathname === "/api/harnesses/snapshots") {
    const selected = url.searchParams.get("harnessId");
    return json(selected ? snapshots.filter((row) => row.identity.id === selected) : snapshots);
  }
  if (url.pathname === "/api/harnesses/antigravity/install") {
    if (readFailure) return json({ error: readFailure.error, message: "refused" }, readFailure.status);
    if (method === "POST") {
      const started = job({ phase: "running" });
      jobs = [started];
      return json(started);
    }
    if (method === "DELETE") {
      jobs = jobs.map((item) => ({ ...item, phase: "cancelled" as const, finishedAt: Date.now() }));
      return json(jobs[0] ?? null);
    }
    if (nextJob) { jobs = [nextJob]; nextJob = undefined; }
    return json({ preview, job: jobs[0] ?? null });
  }
  if (url.pathname === "/api/harnesses/antigravity/setup-terminal") {
    const action = url.searchParams.get("action");
    return json({ harnessId: "antigravity", action, target: "local", command: action === "install" ? preview.command : "agy" });
  }
  return json({ message: `not stubbed ${url.pathname}` }, 404);
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { HarnessSettings } = await import("../widgets/runtime.tsx");
const installs = await import("../widgets/installs.ts");
const presentation = await import("../widgets/installPresentation.ts");
const { invalidateRuntimeCatalogs } = await import("@polyth/models/runtime-catalog");

const flush = async (rounds = 6) => {
  for (let index = 0; index < rounds; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2)); });
};
const notices: Array<{ title: string; kind: string }> = [];
const host = (): WebPackageHost => ({
  slots: { register: () => () => {}, list: () => [] },
  store: { select: (selector: (state: Record<string, unknown>) => unknown) => selector({ activeProjectId: "p1", activeSessionId: null }), getSnapshot: () => ({ activeProjectId: "p1" }), subscribe: () => () => {} },
  sessions: { get: () => undefined },
  errors: { friendly: (_action: string, cause: unknown) => cause instanceof Error ? cause.message : String(cause) },
  navigation: { setOverlay: () => {}, openWorkspacePane: () => true, openSettingsPage: () => {} },
  notifications: {
    show: (input: { title: string; kind: string }) => { notices.push(input); return { id: "n", update: (patch: { title?: string; kind?: string }) => { notices.push({ ...input, ...patch }); }, dismiss() {} }; },
    update: () => true, dismiss() {},
  },
  ui: { Slot: () => null, locale: { get: () => "en", translate } },
} as unknown as WebPackageHost);

const agy = (over: Partial<HarnessSnapshot> = {}): HarnessSnapshot => ({
  identity: { id: "antigravity", name: "Antigravity", integration: "stream-json" },
  policy: { enabled: true, priority: 30, autoSelect: false },
  availability: { harnessId: "antigravity", state: "not-installed", installed: false, healthy: false, authenticated: "unknown", checkedAt: 1 },
  context: { spaceId: "s", projectId: "p1", cwd: "/p", revision: "r", fetchedAt: 1 },
  setup: { installCommand: preview.command, signInCommand: "agy", setupUrl: preview.setupUrl },
  ...over,
});
const installedAgy = () => agy({ identity: { id: "antigravity", name: "Antigravity", integration: "stream-json", version: "1.4.7" }, availability: { harnessId: "antigravity", state: "auth-required", installed: true, healthy: true, authenticated: false, checkedAt: 2 } });

async function mount() {
  installs.resetHarnessInstallsForTest();
  // Each test starts from the server's rows, not the previous test's cache.
  invalidateRuntimeCatalogs();
  requests.length = 0;
  notices.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(HarnessSettings, { host: host() })); });
  await flush();
  return { container, unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); installs.resetHarnessInstallsForTest(); } };
}
const click = async (element: Element | null | undefined) => {
  assert.ok(element, "element to click");
  await act(async () => { (element as HTMLElement).click(); });
  await flush();
};
const button = (root: ParentNode, text: string) => [...root.querySelectorAll("button, a")].find((element) => element.textContent?.trim() === text);
const dialog = () => document.querySelector(".pkg-harnesses-install-dialog");

// ---- wording ----------------------------------------------------------------

test("the machine is named the way the person sees it, on every system", () => {
  const t = (key: string, values?: Record<string, string | number>) => translate(`harnessruntime.install.${key}`, values);
  const words = (os: "darwin" | "win32" | "linux" | "other", browserOnMachine: boolean) => presentation.machineWords({ machine: { kind: "local", os }, browserOnMachine }, t);
  assert.deepEqual(words("darwin", true), { on: "on this Mac", title: "This Mac" });
  assert.deepEqual(words("win32", true), { on: "on this PC", title: "This PC" });
  assert.deepEqual(words("linux", true), { on: "on this computer", title: "This computer" });
  assert.deepEqual(words("darwin", false), { on: "on the Mac running Polyth", title: "The Mac running Polyth" }, "a phone is told which machine it is");
  assert.deepEqual(words("other", false).on, "on the computer running Polyth");
  assert.deepEqual(presentation.machineWords({ machine: { kind: "remote", label: "dev@box" }, browserOnMachine: false }, t), { on: "on dev@box", title: "dev@box" });
  assert.equal(presentation.osWords({ machine: { kind: "local", os: "win32" } }, t), "Windows");
  assert.equal(presentation.osWords({ machine: { kind: "remote", label: "x" } }, t), "SSH host");
  assert.equal(presentation.sourceList(["nodejs.org", "registry.npmjs.org"], "en"), "nodejs.org and registry.npmjs.org");
  assert.equal(presentation.formatElapsed(42_400), "0:42");
  assert.equal(presentation.formatElapsed(3_729_000), "1:02:09");
});

test("failures explain themselves in plain words; unknown ones quote the installer", () => {
  const t = (key: string, values?: Record<string, string | number>) => translate(`harnessruntime.install.${key}`, values);
  const words = { on: "on this Mac" };
  const copy = (failure: HarnessInstallDto["failure"]) => presentation.failureCopy({ harnessName: "Antigravity", sources: ["antigravity.google"], failure }, words, t, "en");
  assert.match(copy({ kind: "network", message: "" }).hint, /starts at antigravity\.google/);
  assert.match(copy({ kind: "disk-space", message: "" }).hint, /on this Mac/);
  assert.equal(copy({ kind: "prerequisite", message: "", tool: "curl" }).hint, "Install curl with the system’s package manager, then try again.");
  assert.equal(copy({ kind: "unsupported-platform", message: "" }).summary, "Antigravity doesn’t support this system.");
  assert.deepEqual(copy({ kind: "unknown", message: "npm error 404" }), { summary: "Something went wrong during the install.", hint: "The installer’s last lines:", quote: "npm error 404" });
  for (const kind of ["permission", "checksum", "timeout", "not-found-after-install", "interrupted"] as const) {
    const text = copy({ kind, message: "" });
    assert.ok(text.summary && !text.summary.includes("harnessruntime"), `${kind} has words`);
  }
});

test("steps and the next step after installing follow what Polyth knows", () => {
  const states = (phase: HarnessInstallDto["phase"], failure?: HarnessInstallDto["failure"]) => presentation.installSteps({ phase, ...(failure ? { failure } : {}) }).map((step) => step.state);
  assert.deepEqual(states("running"), ["active", "pending", "pending"]);
  assert.deepEqual(states("verifying"), ["done", "active", "pending"]);
  assert.deepEqual(states("succeeded"), ["done", "done", "done"]);
  assert.deepEqual(states("failed", { kind: "not-found-after-install", message: "" }), ["done", "failed", "pending"]);
  assert.equal(presentation.nextStepAfterInstall(undefined, false), "none");
  assert.equal(presentation.nextStepAfterInstall(installedAgy(), true), "checking");
  assert.equal(presentation.nextStepAfterInstall(installedAgy(), false), "sign-in");
  assert.equal(presentation.nextStepAfterInstall({ ...installedAgy(), availability: { ...installedAgy().availability, state: "ready", authenticated: true } }, false), "ready");
  assert.equal(presentation.nextStepAfterInstall({ ...installedAgy(), availability: { ...installedAgy().availability, state: "unknown", authenticated: "unknown" } }, false), "sign-in",
    "a fresh install whose sign-in cannot be seen yet is offered Sign in (Later keeps it optional)");
  assert.equal(presentation.nextStepAfterInstall({ ...installedAgy(), setup: {} }, false), "setup");
});

// ---- mounted ----------------------------------------------------------------

test("Install opens a calm confirmation and starts the server's own installer without a terminal or a command", async () => {
  snapshots = [agy()];
  jobs = [];
  readFailure = undefined;
  const view = await mount();
  try {
    await click(button(view.container, "Install"));
    const confirm = dialog();
    assert.ok(confirm, "the install dialog is open");
    assert.match(confirm.textContent ?? "", /Install Antigravity/);
    assert.match(confirm.textContent ?? "", /sets it up on this Mac\. There is nothing to type\./);
    assert.match(confirm.textContent ?? "", /The official installer comes from antigravity\.google\./);
    assert.match(confirm.textContent ?? "", /No administrator password/);
    assert.ok(!document.querySelector(".pkg-harnesses-install-details[open]"), "technical details start closed");
    assert.match(document.querySelector(".pkg-harnesses-install-details")?.textContent ?? "", /curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash/, "the exact command is one disclosure away");
    await click(button(dialog() ?? document, "Install"));
    const post = requests.find((request) => request.method === "POST" && request.path === "/api/harnesses/antigravity/install");
    assert.deepEqual(post?.body, { projectId: "p1" }, "the browser never sends a command");
    assert.match(dialog()?.textContent ?? "", /Installing Antigravity/);
    assert.match(dialog()?.textContent ?? "", /Downloading and installing/);
    assert.ok(button(dialog() ?? document, "Continue in background"));
    // The page row follows the install too.
    assert.match(view.container.querySelector(".pkg-harnesses-row")?.textContent ?? "", /Installing…/);
  } finally {
    await view.unmount();
  }
});

test("a finished install leads straight to sign-in; Sign in opens the harness's own sign-in", async () => {
  snapshots = [agy()];
  jobs = [job({ phase: "running", output: "✓ Platform detected\n⠋ Downloading release package..." })];
  readFailure = undefined;
  const view = await mount();
  try {
    await click(button(view.container, "View progress"));
    assert.match(dialog()?.textContent ?? "", /Downloading release package\.\.\./, "the installer's current step shows under the stage");
    // The install ends on the server; the next poll sees it.
    snapshots = [installedAgy()];
    nextJob = job({ phase: "succeeded", exitCode: 0, finishedAt: Date.now(), result: { installed: true, version: "agy 1.4.7", state: "auth-required" } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, installs.INSTALL_POLL_MS + 200)); });
    await flush(10);
    assert.match(dialog()?.textContent ?? "", /Antigravity is installed/);
    assert.match(dialog()?.textContent ?? "", /Version 1\.4\.7 is now on this Mac\./);
    assert.match(dialog()?.textContent ?? "", /One more step: sign in/);
    assert.ok(requests.some((request) => request.path.startsWith("/api/harnesses/snapshots") && request.path.includes("force=1")), "the page probes the new CLI");
    assert.equal(notices.length, 0, "no notification while the dialog shows the outcome");
    await click(button(dialog() ?? document, "Sign in"));
    assert.equal(dialog(), null, "the install dialog hands over");
    assert.match(document.querySelector(".pkg-harnesses-signin")?.textContent ?? "", /agy/);
  } finally {
    await view.unmount();
  }
});

test("an install hidden mid-way reports its end as a notification", async () => {
  snapshots = [agy()];
  jobs = [job({ phase: "running" })];
  readFailure = undefined;
  const view = await mount();
  try {
    await click(button(view.container, "View progress"));
    await click(button(dialog() ?? document, "Continue in background"));
    assert.equal(dialog(), null);
    assert.deepEqual(notices.map((notice) => [notice.kind, notice.title]), [["progress", "Installing Antigravity…"]]);
    nextJob = job({ phase: "failed", exitCode: 6, finishedAt: Date.now(), failure: { kind: "network", message: "The download did not get through." } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, installs.INSTALL_POLL_MS + 200)); });
    await flush();
    assert.deepEqual(notices.at(-1) && [notices.at(-1)!.kind, notices.at(-1)!.title], ["error", "Couldn’t install Antigravity"]);
    assert.match(view.container.querySelector(".pkg-harnesses-row")?.textContent ?? "", /Install failed/);
    await click(button(view.container, "Install"));
    assert.match(dialog()?.textContent ?? "", /The download didn’t get through\./);
    assert.ok(button(dialog() ?? document, "Try again"));
  } finally {
    await view.unmount();
  }
});

test("Stop cancels a running install", async () => {
  snapshots = [agy()];
  jobs = [job({ phase: "running" })];
  readFailure = undefined;
  const view = await mount();
  try {
    await click(button(view.container, "View progress"));
    await click(button(dialog() ?? document, "Stop"));
    assert.ok(requests.some((request) => request.method === "DELETE" && request.path === "/api/harnesses/antigravity/install?projectId=p1"));
    assert.match(dialog()?.textContent ?? "", /Installation stopped/);
  } finally {
    await view.unmount();
  }
});

test("someone who cannot install is told who can, and nothing starts", async () => {
  snapshots = [agy()];
  jobs = [];
  readFailure = { status: 403, error: "forbidden" };
  const view = await mount();
  try {
    await click(button(view.container, "Install"));
    assert.match(dialog()?.textContent ?? "", /Only the server owner, or someone they allow, can install Antigravity/);
    assert.equal(button(dialog() ?? document, "Install"), undefined, "no install button in the dialog");
    assert.ok(!requests.some((request) => request.method === "POST"));
  } finally {
    readFailure = undefined;
    await view.unmount();
  }
});

test("an install the server no longer knows (it restarted) ends as interrupted instead of spinning forever", async () => {
  snapshots = [agy()];
  jobs = [job({ phase: "running" })];
  readFailure = undefined;
  const view = await mount();
  try {
    await click(button(view.container, "View progress"));
    jobs = [];
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, installs.INSTALL_POLL_MS + 200)); });
    await flush();
    assert.match(dialog()?.textContent ?? "", /Couldn’t install Antigravity/);
    assert.match(dialog()?.textContent ?? "", /Polyth stopped before the install finished\./);
    assert.ok(button(dialog()!, "Try again"));
  } finally {
    await view.unmount();
  }
});

test("a success that a later check no longer confirms offers the install again", async () => {
  snapshots = [agy({ availability: { harnessId: "antigravity", state: "not-installed", installed: false, healthy: false, authenticated: "unknown", checkedAt: 5_000 } })];
  jobs = [job({ phase: "succeeded", startedAt: 1_000, finishedAt: 2_000, exitCode: 0, result: { installed: true, state: "unknown" } })];
  readFailure = undefined;
  const view = await mount();
  try {
    await click(button(view.container, "Install"));
    assert.match(dialog()?.textContent ?? "", /Install Antigravity/);
    assert.ok(button(dialog()!, "Install"), "the confirm step, not a stale Done");
  } finally {
    await view.unmount();
  }
});

test("a server without background installs falls back to the Terminal install", async () => {
  snapshots = [agy()];
  jobs = [];
  readFailure = { status: 404, error: "not-found" };
  const view = await mount();
  try {
    await click(button(view.container, "Install"));
    assert.equal(document.querySelector(".pkg-harnesses-install-dialog"), null);
    const terminal = document.querySelector(".pkg-harnesses-signin-dialog");
    assert.ok(terminal, "the Terminal install dialog opens instead");
    assert.match(terminal.textContent ?? "", /Open terminal and install/);
    assert.match(terminal.textContent ?? "", /antigravity\.google\/cli\/install\.sh/);
  } finally {
    readFailure = undefined;
    await view.unmount();
  }
});
