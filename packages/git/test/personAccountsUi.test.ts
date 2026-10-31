// Settings → Source control "Your accounts" (Spaces §14.4): the person's own
// commit identity, the Space service-account policy, owner-only checkout
// identity and the fixable Git refusals.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  ResizeObserver: dom.ResizeObserver,
  getComputedStyle: (elt: Element) =>
    (dom as unknown as { getComputedStyle(el: Element): CSSStyleDeclaration }).getComputedStyle(elt),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

type Rec = { method: string; path: string; body?: unknown };
const requests: Rec[] = [];
let profile: { name: string; email: string; updatedAt: number } | null = null;
let fallback = false;
let policy = { agentsMayUseService: false };
let role = "admin";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://127.0.0.1:4400");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
  requests.push({ method, path: url.pathname, ...(body ? { body } : {}) });
  if (url.pathname === "/api/git/profile") {
    if (method === "PUT") {
      if (!String(body?.email ?? "").includes("@")) return json({ error: "invalid-input", field: "email", message: "Enter a valid email address." }, 400);
      profile = { name: String(body!.name), email: String(body!.email), updatedAt: 1 };
    }
    if (method === "DELETE") profile = null;
    return json({ profile, usesInstallationFallback: fallback });
  }
  if (url.pathname === "/api/git/service-policy") {
    if (method === "PUT") policy = { agentsMayUseService: body!.agentsMayUseService === true };
    return json(policy);
  }
  if (url.pathname === "/api/spaces") return json({ spaces: [{ id: "sp1", name: "Home", role }], activeSpaceId: "sp1" });
  if (url.pathname === "/api/git/remotes") return json({ remotes: [{ remoteName: "origin", direction: "fetch", url: "https://github.com/acme/repo.git" }], rejected: [] });
  if (url.pathname === "/api/git/identity") {
    if (method === "POST") return json({ name: String(body!.name), email: String(body!.email), sshKey: null });
    return json({ name: "Checkout User", email: "checkout@example.com", sshKey: null });
  }
  if (url.pathname === "/api/git/accounts") return json({ accounts: [] });
  return json({ error: "not-found", message: `unexpected ${method} ${url.pathname}` }, 404);
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: PersonGitProfileSection } = await import("../widgets/PersonGitProfileSection.tsx");
const { default: GitSettings, gitSettingsTabFor } = await import("../widgets/GitSettings.tsx");
const { default: SourceControlIdentity } = await import("../widgets/SourceControlIdentity.tsx");
const { resetPersonGitProfile, loadPersonGitProfile, mayWriteCheckoutIdentity } = await import("../widgets/personGitProfile.ts");
const { gitRefusalOf, reportGitError } = await import("../widgets/gitRefusal.ts");
const { reconcileSourceControlIdentity } = await import("../widgets/sourceControlRuntime.ts");
const { saveSourceControlProfile, setRepositorySourceControlProfile } = await import("../widgets/sourceControlProfiles.ts");
const { clearUiError, getState } = await import("../../../apps/web/src/store.ts");

const flush = async (rounds = 8) => {
  for (let index = 0; index < rounds; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
async function mounted(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(node); });
  await flush();
  return { container, unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}
const setValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }) as unknown as Event);
};
// happy-dom does not turn a submit-button click into a submit event.
const submit = (form: HTMLFormElement) => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
const button = (root: ParentNode, label: RegExp) =>
  [...root.querySelectorAll("button")].find((candidate) => label.test(candidate.textContent ?? "") || label.test(candidate.getAttribute("aria-label") ?? ""));
const reset = () => {
  requests.length = 0;
  profile = null;
  fallback = false;
  policy = { agentsMayUseService: false };
  role = "admin";
  resetPersonGitProfile();
};
const opened: Array<{ pageId: string; target?: unknown }> = [];
const host = {
  ui: { Slot: () => null },
  navigation: { openSettingsPage: (pageId: string, target?: unknown) => { opened.push({ pageId, target }); } },
} as unknown as WebPackageHost;

test("your commit identity saves trimmed values and maps a field refusal onto its field", async () => {
  reset();
  const view = await mounted(createElement(PersonGitProfileSection));
  try {
    const text = view.container.textContent ?? "";
    assert.match(text, /Your commit identity/);
    assert.match(text, /refused until you add your name and email/, "a member without a profile is told why commits fail");
    const [name, email] = [...view.container.querySelectorAll<HTMLInputElement>("input")];
    assert.ok(name && email);
    await act(async () => { setValue(name, "  Ada Lovelace "); setValue(email, "not-an-email"); });
    await act(async () => { submit(view.container.querySelector("form")!); });
    await flush();
    assert.equal(email.getAttribute("aria-invalid"), "true");
    assert.match(view.container.querySelector(".settings-field-error")?.textContent ?? "", /valid email/);

    await act(async () => { setValue(email, " ada@example.com "); });
    await act(async () => { submit(view.container.querySelector("form")!); });
    await flush();
    const put = requests.filter((row) => row.method === "PUT" && row.path === "/api/git/profile").at(-1);
    assert.deepEqual(put?.body, { name: "Ada Lovelace", email: "ada@example.com" });
    assert.match(view.container.textContent ?? "", /Every commit Polyth makes for you carries this name and email/);
    assert.ok(button(view.container, /^Remove$/), "a saved profile can be removed");
  } finally {
    await view.unmount();
  }
});

const tabs = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.textContent?.trim() ?? "");
const tab = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLElement>('[role="tab"]')].find((candidate) => candidate.textContent?.trim() === label);

test("the settings page shows Space service accounts to admins and checkout identity only to the instance owner", async () => {
  reset();
  role = "admin";
  fallback = false;
  let view = await mounted(createElement(GitSettings, { host }));
  try {
    const text = view.container.textContent ?? "";
    assert.match(text, /Your commit identity/);
    assert.doesNotMatch(text, /Repository identities/, "only the instance owner manages checkout identities");
    assert.ok(view.container.querySelector('[data-settings-item="git.personAccounts"]'), "the provider sections have a deep-link target");
    assert.deepEqual(tabs(view.container), ["Accounts", "Workflow", "Display", "Space"], "no project: no This project tab; an admin gets Space");
    await act(async () => { tab(view.container, "Space")!.click(); });
    await flush();
    assert.match(view.container.textContent ?? "", /Space service accounts/);
    const toggle = view.container.querySelector<HTMLElement>('[data-settings-item="git.servicePolicy"] [role="switch"], [data-settings-item="git.servicePolicy"] input[type="checkbox"]');
    assert.ok(toggle, "the policy is a switch");
    await act(async () => { toggle.click(); });
    await flush();
    assert.deepEqual(requests.find((row) => row.method === "PUT" && row.path === "/api/git/service-policy")?.body, { agentsMayUseService: true });
  } finally {
    await view.unmount();
  }

  reset();
  role = "member";
  view = await mounted(createElement(GitSettings, { host }));
  try {
    assert.deepEqual(tabs(view.container), ["Accounts", "Workflow", "Display"], "members never see the Space tab");
    assert.doesNotMatch(view.container.textContent ?? "", /Space service accounts/, "members never see the Space policy");
    assert.ok(view.container.querySelector(".git-settings-tab-dot"), "a member without a commit identity sees the Accounts tab flagged");
  } finally {
    await view.unmount();
  }

  reset();
  role = "owner";
  fallback = true;
  view = await mounted(createElement(GitSettings, { host }));
  try {
    assert.match(view.container.textContent ?? "", /Repository identities/, "the instance owner manages checkout identities");
    assert.equal(view.container.querySelector(".git-settings-tab-dot"), null, "the owner's commits fall back to the server's Git config");
  } finally {
    await view.unmount();
  }
});

test("a settings target opens the tab that owns the row, also when it changes on an open page", async () => {
  assert.equal(gitSettingsTabFor({ itemId: "git.personProfile" }), "accounts");
  assert.equal(gitSettingsTabFor({ itemId: "git.projectIdentity" }), "project");
  assert.equal(gitSettingsTabFor({ itemId: "git.branchTemplate" }), "workflow");
  assert.equal(gitSettingsTabFor({ itemId: "git.diffLayout" }), "display");
  assert.equal(gitSettingsTabFor({ itemId: "git.servicePolicy" }), "space");
  assert.equal(gitSettingsTabFor({ sectionId: "display" }), "display", "a tab id may be named directly");
  assert.equal(gitSettingsTabFor({ itemId: "elsewhere" }), null, "an unknown row keeps the current tab");
  assert.equal(gitSettingsTabFor(undefined), null);

  reset();
  role = "admin";
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (settingsTarget?: { itemId?: string; sectionId?: string }) => {
    await act(async () => { root.render(createElement(GitSettings, { host, ...(settingsTarget ? { settingsTarget } : {}) })); });
    await flush();
  };
  try {
    await render({ itemId: "git.diffLayout" });
    assert.equal(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(), "Display");
    assert.ok(container.querySelector('[data-settings-item="git.diffLayout"]'), "the targeted row is on screen");
    await render({ itemId: "git.servicePolicy" });
    assert.equal(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(), "Space", "a new target on the open page switches tabs");
    assert.ok(container.querySelector('[data-settings-item="git.servicePolicy"]'));
    await render({ itemId: "git.projectIdentity" });
    assert.equal(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(), "Accounts", "a tab that is not offered (no project) falls back to Accounts");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("checkout identity is reconciled only for the instance owner", async () => {
  reset();
  saveSourceControlProfile({ id: "work", label: "Work", provider: "generic", commitAuthor: { name: "Work Me", email: "me@work.example" }, authentication: { mode: "system-git" } });
  setRepositorySourceControlProfile("owner-gate", "work");
  fallback = false;
  await reconcileSourceControlIdentity("owner-gate");
  assert.equal(requests.some((row) => row.method === "POST" && row.path === "/api/git/identity"), false, "a member never writes the checkout's Git config");
  assert.equal(mayWriteCheckoutIdentity(), false);

  reset();
  fallback = true;
  await loadPersonGitProfile(true);
  await reconcileSourceControlIdentity("owner-gate");
  assert.ok(requests.some((row) => row.method === "POST" && row.path === "/api/git/identity"), "the instance owner keeps checkout identities");
});

test("a member's repository chip names their own identity and asks for one when missing", async () => {
  reset();
  fallback = false;
  await loadPersonGitProfile(true);
  const view = await mounted(createElement(SourceControlIdentity, { host, projectId: "chip" }));
  try {
    const trigger = view.container.querySelector<HTMLButtonElement>(".source-control-identity-trigger");
    assert.ok(trigger);
    assert.match(trigger.textContent ?? "", /Set commit identity/);
    assert.equal(trigger.getAttribute("data-attention"), "true");
    assert.equal(view.container.querySelector("[data-identity-owner=person]") !== null, true);
  } finally {
    await view.unmount();
  }
});

test("fixable Git refusals carry an action to the setting that fixes them", () => {
  const identity = Object.assign(new Error("Set your git name and email in Profile → Git."), { code: "git-identity-required" });
  const account = Object.assign(new Error("Connect your GitHub/GitLab account for github.com in Profile → Accounts and turn it on for this Space."), { code: "git-account-required" });
  const member = Object.assign(new Error("You are no longer a member of this Space."), { code: "git-account-required" });
  assert.deepEqual(gitRefusalOf(identity), { code: "git-identity-required", label: "Set commit identity", itemId: "git.personProfile" });
  assert.deepEqual(gitRefusalOf(account), { code: "git-account-required", label: "Connect account", itemId: "git.personAccounts" });
  assert.equal(gitRefusalOf(member), null, "nothing in Settings fixes a lost membership");
  assert.equal(gitRefusalOf(new Error("boom")), null);

  clearUiError();
  reportGitError("Couldn't update the repository", account);
  const state = getState();
  assert.match(state.uiError ?? "", /Connect your GitHub\/GitLab account/);
  assert.equal(state.uiErrorAction?.label, "Connect account");
  reportGitError("Couldn't update the repository", new Error("plain failure"));
  assert.equal(getState().uiErrorAction, null);
  clearUiError();
});
