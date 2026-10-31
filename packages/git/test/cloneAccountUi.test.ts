import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Element: dom.Element, Node: dom.Node,
  Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  location: dom.location, history: dom.history,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (cb: FrameRequestCallback) => { cb(0); return 1; } });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
Object.defineProperty(dom, "matchMedia", { configurable: true, value: () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} }) });

const accounts = [
  { provider: "github", accountId: "github.com/alice", providerLabel: "GitHub", login: "alice", origin: "https://github.com", transport: "token", active: false },
  { provider: "github", accountId: "github.com/bob", providerLabel: "GitHub", login: "bob", origin: "https://github.com", transport: "token", active: true },
  { provider: "gitlab", accountId: "lab-1", providerLabel: "GitLab", login: "carol", origin: "https://gitlab.example.com", transport: "token" },
];
const posts: Array<Record<string, unknown>> = [];
let listed = accounts;
const respond = (body: unknown) => ({ ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) });
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/git/accounts")) return respond({ accounts: listed, unavailable: [] });
    if (url.includes("/api/projects/clone")) {
      posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return respond({ id: `p${posts.length}`, name: "repo", path: "/work/repo" });
    }
    if (/\/api\/projects(\?|$)/.test(url)) return respond(posts.map((_, i) => ({ id: `p${i + 1}`, name: "repo", path: "/work/repo" })));
    return respond({});
  },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: GitProjectSource } = await import("../widgets/GitProjectSource.tsx");

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 2)); }); };

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let opened = 0;
  const host = { ui: { Slot: () => null }, navigation: { openSettingsPage() {} } };
  await act(async () => {
    root.render(createElement(GitProjectSource, {
      host, busy: false, browsedPath: "/work", armedId: null, arm() {}, disarm() {}, onProjectOpened: () => { opened += 1; },
    }));
  });
  await act(async () => { (container.querySelector(".git-clone-source") as HTMLButtonElement).click(); });
  await flush();
  const type = async (value: string) => {
    const input = container.querySelector(".git-clone-url input") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    });
    await flush();
  };
  const submit = async () => {
    await act(async () => { (container.querySelector(".git-clone-actions .ui-btn--primary") as HTMLButtonElement).click(); });
    await flush();
  };
  return {
    container, type, submit, get opened() { return opened; },
    accountText: () => container.querySelector(".git-clone-account-picker .picker-chip-text")?.textContent ?? "",
    async close() { await act(async () => root.unmount()); container.remove(); },
  };
}

test("the clone panel suggests the active account for the host and clones as the chosen one", async () => {
  posts.length = 0;
  listed = accounts;
  const view = await mount();
  try {
    assert.equal(view.container.querySelector(".git-clone-access"), null, "no account card before a valid address");
    await view.type("https://github.com/o/repo.git");
    assert.equal(view.accountText(), "@bob", "the provider's active account is the default");
    assert.match(view.container.querySelector(".git-clone-access-note")?.textContent ?? "", /@bob/);
    assert.match(view.container.querySelector(".git-clone-destination")?.textContent ?? "", /\/work\/repo/);

    await act(async () => { (view.container.querySelector(".git-clone-account-picker .picker-chip") as HTMLButtonElement).click(); });
    const options = [...document.querySelectorAll(".picker-item")].map((el) => el.querySelector(".palette-label")?.textContent);
    assert.deepEqual(options, ["@alice", "@bob", "System Git"], "only accounts of this host are offered");
    await act(async () => { ([...document.querySelectorAll(".picker-item")][0] as HTMLElement).click(); });
    assert.equal(view.accountText(), "@alice");

    await view.submit();
    assert.deepEqual(posts.at(-1)?.account, { provider: "github", accountId: "github.com/alice" });
    assert.equal(view.opened, 1);
  } finally {
    await view.close();
  }
});

test("a host without accounts clones with System Git and sends no account", async () => {
  posts.length = 0;
  listed = accounts;
  const view = await mount();
  try {
    await view.type("git@git.example.org:team/repo.git");
    assert.equal(view.accountText(), "System Git");
    assert.match(view.container.querySelector(".git-clone-access-note")?.textContent ?? "", /git\.example\.org/);
    await view.submit();
    assert.equal(posts.length, 1);
    assert.equal("account" in posts[0]!, false);
  } finally {
    await view.close();
  }
});

test("an invalid address explains the accepted forms and keeps Clone disabled", async () => {
  const view = await mount();
  try {
    await view.type("github.com/o");
    assert.ok(view.container.querySelector(".git-clone-detected.is-invalid"));
    assert.equal((view.container.querySelector(".git-clone-actions .ui-btn--primary") as HTMLButtonElement).disabled, true);
  } finally {
    await view.close();
  }
});

const { replaceSourceControlProfileState, setSourceControlProfileTransport } = await import("../widgets/sourceControlProfiles.ts");

function useSshIdentities() {
  setSourceControlProfileTransport({
    load: async () => ({ state: { profiles: [], globalDefaultProfileId: null, repositoryProfileIds: {}, repositorySystemIdentities: {} }, revision: 1 }),
    save: async (state, revision) => ({ state, revision: revision + 1 }),
  });
  replaceSourceControlProfileState({
    profiles: [
      {
        id: "p-ex", label: "Personal", provider: "github", username: "example-org",
        commitAuthor: { name: "S D", email: "sd@example.com" },
        authentication: { mode: "ssh-key", identityFile: "/home/u/.ssh/id_sd" },
      },
      { id: "p-plain", label: "Work", provider: "github", username: "worker", authentication: { mode: "system-git" } },
    ],
    globalDefaultProfileId: null, repositoryProfileIds: {}, repositorySystemIdentities: {},
  });
}

const pick = async (picker: string, label: string) => {
  await act(async () => { (document.querySelector(`${picker} .picker-chip`) as HTMLButtonElement).click(); });
  const item = [...document.querySelectorAll(".picker-item")].find((el) => el.querySelector(".palette-label")?.textContent === label);
  assert.ok(item, `${label} is offered`);
  await act(async () => { (item as HTMLElement).click(); });
};

test("an identity with an SSH key is offered as the account, clones over SSH and is the commit author", async () => {
  posts.length = 0;
  listed = accounts;
  useSshIdentities();
  const view = await mount();
  try {
    await view.type("https://github.com/o/repo.git");
    assert.equal(view.accountText(), "@bob", "a connected account stays the default");
    await act(async () => { (view.container.querySelector(".git-clone-account-picker .picker-chip") as HTMLButtonElement).click(); });
    const options = [...document.querySelectorAll(".picker-item")].map((el) => el.querySelector(".palette-label")?.textContent);
    assert.deepEqual(options, ["@alice", "@bob", "@example-org", "System Git"], "only identities with an SSH key sign in");
    await act(async () => { ([...document.querySelectorAll(".picker-item")][2] as HTMLElement).click(); });

    assert.equal(view.accountText(), "@example-org");
    const identityPicker = view.container.querySelector(".git-clone-identity-picker .picker-chip") as HTMLButtonElement;
    assert.equal(identityPicker.disabled, true, "the identity that signs in is also the commit author");
    assert.match(identityPicker.textContent ?? "", /Personal/);
    assert.match(view.container.querySelector(".git-clone-access-note")?.textContent ?? "", /SSH address.*id_sd/);

    await view.submit();
    assert.deepEqual(posts.at(-1)?.identity, { profileId: "p-ex" });
    assert.equal("account" in posts.at(-1)!, false);
  } finally {
    await view.close();
  }
});

test("choosing an SSH-key identity as the commit author also signs in with it", async () => {
  posts.length = 0;
  listed = accounts;
  useSshIdentities();
  const view = await mount();
  try {
    await view.type("https://github.com/o/repo.git");
    await pick(".git-clone-identity-picker", "Work");
    assert.equal(view.accountText(), "@bob", "an identity without a key leaves the account alone");
    await pick(".git-clone-identity-picker", "Personal");
    assert.equal(view.accountText(), "@example-org");
    await view.submit();
    assert.deepEqual(posts.at(-1)?.identity, { profileId: "p-ex" });
  } finally {
    await view.close();
  }
});
