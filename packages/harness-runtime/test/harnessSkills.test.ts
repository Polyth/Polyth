import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import type { HarnessNativeSkillListDto } from "@polyth/contracts/capability-installations";
import type { WebPackageHost } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);
const { en: enMessages } = await import("../src/i18n/en.ts");
/** The shell's lookup over the package's English catalog. */
const enTranslate = (key: string, values: Record<string, string | number> = {}) =>
  ((enMessages as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_: string, name: string) => String(values[name] ?? `{${name}}`));

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
  cancelAnimationFrame: () => {},
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const puts: Array<{ path: string; body: Record<string, unknown> }> = [];
let manage = true;
let list: HarnessNativeSkillListDto;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), "http://localhost:3000");
  if (url.pathname === "/api/harnesses/access") return json({ manage });
  if (url.pathname !== "/api/harnesses/claude/skills") return json({ message: "not found" }, 404);
  if ((init?.method ?? "GET") === "GET") return json(list);
  const body = JSON.parse(String(init!.body)) as { inherit?: boolean; skill?: { name: string; enabled: boolean } };
  puts.push({ path: `${url.pathname}${url.search}`, body });
  const inherit = body.inherit ?? list.inherit;
  list = {
    ...list,
    inherit,
    skills: list.skills.map((skill) => ({ ...skill, enabled: inherit && (body.skill?.name === skill.name ? body.skill.enabled : skill.enabled || body.inherit === true) })),
  };
  return json(list);
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: HarnessSkills } = await import("../widgets/HarnessSkills.tsx");

const flush = async (rounds = 8) => {
  for (let index = 0; index < rounds; index++) await act(async () => { await Promise.resolve(); });
};
const host = { errors: { friendly: (_: string, cause: unknown) => String(cause) }, ui: { locale: { get: () => "en", translate: enTranslate } } } as unknown as WebPackageHost;
const toggle = (root: ParentNode, label: string) => {
  const found = [...root.querySelectorAll<HTMLElement>('[role="switch"]')].find((item) => item.getAttribute("aria-label") === label);
  assert.ok(found, `missing switch ${label}`);
  return found as HTMLButtonElement;
};

async function mount(projectId = "p1") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(HarnessSkills, { host, harnessId: "claude", projectId })); });
  await flush();
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("inheriting Claude skills, then muting one, sends one scoped policy change each", async () => {
  manage = true;
  puts.length = 0;
  list = {
    harnessId: "claude", inherit: false, supported: true, applies: "next-session", checkedAt: 1,
    skills: [
      { name: "deploy", source: "project", enabled: false, description: "Ship it" },
      { name: "pdf", source: "user", enabled: false },
      { name: "tools:lint", source: "plugin", plugin: "tools@m", enabled: false },
    ],
  };
  const view = await mount();
  try {
    const text = view.container.textContent ?? "";
    assert.match(text, /This project/);
    assert.match(text, /Your skills/);
    assert.match(text, /From plugins/);
    assert.equal(toggle(view.container, "Use pdf").disabled, true, "per-skill switches wait for inheritance");
    await act(async () => { toggle(view.container, "Inherit claude skills").click(); });
    await flush();
    assert.deepEqual(puts.at(-1), { path: "/api/harnesses/claude/skills?projectId=p1", body: { inherit: true } });
    await act(async () => { toggle(view.container, "Mute pdf").click(); });
    await flush();
    assert.deepEqual(puts.at(-1)?.body, { skill: { name: "pdf", enabled: false } });
    assert.match(view.container.textContent ?? "", /Muted/);
    assert.match(view.container.textContent ?? "", /2 of 3 offered/);
  } finally {
    await view.unmount();
  }
});

test("an unsupported deployment explains why and locks every switch", async () => {
  manage = true;
  list = { harnessId: "claude", inherit: false, supported: false, unsupportedReason: "Local single-user Polyth only", applies: "next-session", checkedAt: 1, skills: [] };
  const view = await mount();
  try {
    assert.match(view.container.textContent ?? "", /Local single-user Polyth only/);
    assert.equal(toggle(view.container, "Inherit claude skills").disabled, true);
  } finally {
    await view.unmount();
  }
});
