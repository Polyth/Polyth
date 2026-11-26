// Settings > Users > Add user: mount the real three-step flow against a mocked
// server. A person is named, given a preset and handed their sign-in; a
// protected person never reaches the Space without Protected mode.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "https://polyth.example.org/?settings=users" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  Event: dom.Event,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Call { method: string; path: string; body: Record<string, unknown> | null }
let calls: Call[] = [];
let guardrailsStatus = 200;
// Off by default: the older-server path, where the wizard hands over a password.
let invitationUrl: string | null = null;
const json = (status: number, body: unknown) => ({
  ok: status < 400, status, statusText: "", headers: { get: () => null },
  json: async () => body, text: async () => JSON.stringify(body),
});
(globalThis as { fetch?: unknown }).fetch = async (path: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
  calls.push({ method, path, body });
  if (path === "/api/auth/status") return json(200, { required: true, authorized: true, scope: "ui-session", csrfToken: "a".repeat(64) });
  if (path === "/api/auth/accounts" && method === "POST") return json(200, { id: "usr_new", name: body?.name, login: body?.login, status: "active", revision: 1 });
  if (path === "/api/auth/accounts/usr_new/guardrails" && method === "GET") return json(200, { userId: "usr_new", guardrails: null, revision: 0 });
  if (path === "/api/auth/accounts/usr_new/guardrails") {
    return guardrailsStatus === 200
      ? json(200, { userId: "usr_new", guardrails: body?.guardrails, revision: 1 })
      : json(guardrailsStatus, { error: "conflict", message: "changed elsewhere" });
  }
  if (path === "/api/spaces/spc_home/members" && method === "POST") return json(200, { userId: body?.userId, spaceId: "spc_home", role: body?.role, createdAt: 1 });
  if (path === "/api/auth/accounts/usr_new/invitation" && method === "POST") {
    return invitationUrl ? json(200, { code: "x", url: invitationUrl, expiresAt: Date.UTC(2026, 11, 2) }) : json(404, { error: "not-found" });
  }
  if (path.startsWith("/api/projects")) return json(200, []);
  return json(404, { error: "not-found" });
};

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: AddUserWizard } = await import("../src/components/settings/AddUserWizard.tsx");

const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const space = { id: "spc_home", name: "Home", role: "owner" as const, canManageMembers: true, members: [] };

async function mount(spaceAccess: typeof space | null = space) {
  calls = [];
  const events: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(AddUserWizard, {
      spaceAccess,
      withReauth: <T,>(action: () => Promise<T>) => action(),
      onClose: () => events.push("close"),
      onCreated: (account: { id: string }) => events.push(`created:${account.id}`),
      onOpenAccount: (id: string) => events.push(`open:${id}`),
    }));
  });
  await settle();
  // The dialog renders into a portal on document.body.
  const panel = () => document.querySelector<HTMLElement>(".user-wizard")!;
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    });
  };
  const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); await settle(); };
  const submit = () => panel().querySelector<HTMLButtonElement>(".user-wizard-foot button[type=submit]")!;
  // A closed dialog leaves an exit ghost behind; the next mount starts clean.
  const unmount = async () => {
    await act(async () => { root.unmount(); container.remove(); });
    for (const ghost of document.querySelectorAll(".dialog-backdrop")) ghost.remove();
  };
  return { panel, type, click, submit, events, unmount };
}

test("step one is filled in for you: login follows the name and a temporary password is ready", async () => {
  const view = await mount();
  assert.match(view.panel().textContent ?? "", /Step 1 of 2/);
  assert.match(view.panel().textContent ?? "", /Who are you adding\?/);
  const [name, login, password] = [...view.panel().querySelectorAll<HTMLInputElement>(".user-wizard-body input")];
  // Nothing to invent: the passphrase exists and is visible before anyone asks.
  assert.match(password!.value, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal(password!.type, "text");
  assert.equal(view.submit().disabled, true, "Continue waits for a name");
  await view.type(name!, "Iryna Petrenko");
  assert.equal(login!.value, "iryna");
  assert.equal(view.submit().disabled, false);
  // An edited login is the person's choice and stops following the name.
  await view.type(login!, "iryna.p");
  await view.type(name!, "Iryna Kovalenko");
  assert.equal(login!.value, "iryna.p");
  await view.unmount();
});

test("a protected teammate gets Protected mode before any Space access, then sees their sign-in", async () => {
  const view = await mount();
  const [name] = [...view.panel().querySelectorAll<HTMLInputElement>(".user-wizard-body input")];
  await view.type(name!, "Iryna Petrenko");
  const password = view.panel().querySelectorAll<HTMLInputElement>(".user-wizard-body input")[2]!.value;
  await view.click(view.submit());

  assert.match(view.panel().textContent ?? "", /Step 2 of 2/);
  assert.match(view.panel().textContent ?? "", /What can Iryna Petrenko do\?/);
  const presets = [...view.panel().querySelectorAll<HTMLElement>(".user-wizard-preset")].map((row) => row.dataset.preset);
  assert.deepEqual(presets, ["teammate", "protected", "viewer", "admin", "account"]);
  // Teammate is the quiet default; the role behind each name is shown for pros.
  assert.ok(view.panel().querySelector('.user-wizard-preset[data-preset="teammate"][data-selected]'));
  assert.match(view.panel().querySelector('[data-preset="teammate"] .user-wizard-preset-tag')?.textContent ?? "", /Member/);
  assert.equal(view.panel().querySelector('[data-preset="viewer"] .user-wizard-preset-tag'), null, "Viewer needs no Viewer tag");

  await view.click(view.panel().querySelector('.user-wizard-preset[data-preset="protected"] input')!);
  await view.click(view.submit());

  // (Refreshing the project list afterwards is the shell's business.)
  const writes = calls.filter((call) => call.method !== "GET" && !call.path.startsWith("/api/projects"))
    .map((call) => `${call.method} ${call.path}`);
  assert.deepEqual(writes, [
    "POST /api/auth/accounts",
    "POST /api/auth/accounts/usr_new/guardrails",
    "POST /api/spaces/spc_home/members",
    "POST /api/auth/accounts/usr_new/invitation",
  ]);
  const created = calls.find((call) => call.path === "/api/auth/accounts" && call.method === "POST")!;
  assert.deepEqual(created.body, { login: "iryna", name: "Iryna Petrenko", password });
  const guard = calls.find((call) => call.method === "POST" && call.path.endsWith("/guardrails"))!;
  assert.equal(guard.body?.expectedRevision, 0);
  assert.deepEqual((guard.body?.guardrails as { models: unknown[]; approvals: string }).models, []);
  assert.equal((guard.body?.guardrails as { approvals: string }).approvals, "none");
  assert.equal(calls.find((call) => call.path === "/api/spaces/spc_home/members")!.body?.role, "member");

  const text = view.panel().textContent ?? "";
  assert.match(text, /Iryna Petrenko can sign in now/);
  assert.match(text, /https:\/\/polyth\.example\.org/);
  assert.ok(text.includes(password), "the temporary password is shown once, to hand over");
  assert.match(text, /Protected in Home/);
  assert.deepEqual(view.events, ["created:usr_new"]);

  await view.click([...view.panel().querySelectorAll("button")].find((button) => /Fine-tune access/.test(button.textContent ?? ""))!);
  assert.deepEqual(view.events, ["created:usr_new", "open:usr_new"]);
  await view.unmount();
});

test("a server that issues invitation links hands over the link and folds the password away", async () => {
  invitationUrl = `http://127.0.0.1:4400/#invite=pinv_${"B".repeat(43)}`;
  try {
    const view = await mount();
    const [name] = [...view.panel().querySelectorAll<HTMLInputElement>(".user-wizard-body input")];
    await view.type(name!, "Iryna Petrenko");
    const password = view.panel().querySelectorAll<HTMLInputElement>(".user-wizard-body input")[2]!.value;
    await view.click(view.submit());
    await view.click(view.submit());

    const values = [...view.panel().querySelectorAll(".user-wizard-body > .user-wizard-credentials .user-wizard-credential-value")].map((node) => node.textContent);
    // The server only knew its loopback origin: the link uses the address this page was opened at.
    assert.equal(values[0], `https://polyth.example.org/#invite=pinv_${"B".repeat(43)}`);
    assert.match(view.panel().textContent ?? "", /The link works once, until/);
    const fallback = view.panel().querySelector<HTMLDetailsElement>("details.user-wizard-fallback");
    assert.ok(fallback && !fallback.open, "the temporary password waits behind a disclosure");
    assert.ok(fallback.textContent?.includes(password));
    await view.unmount();
  } finally {
    invitationUrl = null;
  }
});

test("when Protected mode can't be turned on, the new account gets no Space access", async () => {
  guardrailsStatus = 409;
  try {
    const view = await mount();
    const [name] = [...view.panel().querySelectorAll<HTMLInputElement>(".user-wizard-body input")];
    await view.type(name!, "Oleh");
    await view.click(view.submit());
    await view.click(view.panel().querySelector('.user-wizard-preset[data-preset="protected"] input')!);
    await view.click(view.submit());
    assert.equal(calls.some((call) => call.path === "/api/spaces/spc_home/members"), false);
    assert.match(view.panel().textContent ?? "", /Protected mode couldn’t be turned on, so they got no Space access/);
    await view.unmount();
  } finally {
    guardrailsStatus = 200;
  }
});

test("someone who can't add members creates the account only, with or without protection", async () => {
  const view = await mount({ ...space, role: "member", canManageMembers: false } as unknown as typeof space);
  const [name] = [...view.panel().querySelectorAll<HTMLInputElement>(".user-wizard-body input")];
  await view.type(name!, "Anna");
  await view.click(view.submit());
  const presets = [...view.panel().querySelectorAll<HTMLElement>(".user-wizard-preset")].map((row) => row.dataset.preset);
  assert.deepEqual(presets, ["account", "protected"]);
  assert.ok(view.panel().querySelector('.user-wizard-preset[data-preset="account"][data-selected]'));
  assert.match(view.panel().textContent ?? "", /You can't manage members in this Space\./);
  await view.click(view.submit());
  assert.equal(calls.some((call) => call.path.includes("/members")), false);
  assert.equal(calls.some((call) => call.path.endsWith("/guardrails")), false);
  await view.unmount();
});

test("Back keeps what was typed, and the X closes from any step", async () => {
  const view = await mount();
  const [name] = [...view.panel().querySelectorAll<HTMLInputElement>(".user-wizard-body input")];
  await view.type(name!, "Dmytro");
  await view.click(view.submit());
  await view.click([...view.panel().querySelectorAll(".user-wizard-foot button")].find((button) => /Back/.test(button.textContent ?? ""))!);
  assert.equal(view.panel().querySelector<HTMLInputElement>(".user-wizard-body input")!.value, "Dmytro");
  await view.click(view.panel().querySelector('.user-wizard-head button[aria-label="Close"]')!);
  assert.deepEqual(view.events, ["close"]);
  await view.unmount();
});

test("with Polyth Link on and no internet address, Done offers to pair their Polyth app", async () => {
  const { registerSlot } = await import("../src/slots.ts");
  const off = registerSlot("settings.pages", "tunnel", () => null, 42, { label: "Polyth Link", group: "System", pageId: "tunnel" }, "tunnel");
  const opened: unknown[] = [];
  const listen = (event: Event) => opened.push((event as CustomEvent).detail);
  window.addEventListener("polyth:settings-page", listen);
  try {
    const view = await mount();
    const [name] = [...view.panel().querySelectorAll<HTMLInputElement>(".user-wizard-body input")];
    await view.type(name!, "Iryna Petrenko");
    await view.click(view.submit());
    await view.click(view.submit());

    const connect = view.panel().querySelector<HTMLElement>(".user-wizard-connect");
    assert.ok(connect, "the Link way in is offered to a new Space member");
    assert.match(connect.textContent ?? "", /opens only on your network/);
    await view.click(connect.querySelector("button")!);
    assert.ok(view.events.includes("close"), "the flow closes before the Link page opens");
    assert.deepEqual(opened, [{ pageId: "tunnel", target: { sectionId: "pair-for", itemId: "usr_new" } }]);
    await view.unmount();
  } finally {
    window.removeEventListener("polyth:settings-page", listen);
    off();
  }
});

test("without Polyth Link, or for an account outside the Space, Done offers no pairing", async () => {
  const view = await mount();
  const [name] = [...view.panel().querySelectorAll<HTMLInputElement>(".user-wizard-body input")];
  await view.type(name!, "Iryna Petrenko");
  await view.click(view.submit());
  await view.click(view.submit());
  assert.equal(view.panel().querySelector(".user-wizard-connect"), null);
  await view.unmount();
});

// A package's way in besides the browser (`settings.users.invite.methods`).
async function withInviteMethod(meta: Record<string, unknown>, run: () => Promise<void>) {
  const { registerSlot } = await import("../src/slots.ts");
  const off = registerSlot("settings.users.invite.methods", "test.app", () => null, 10, { inviteMethod: meta }, "test");
  try { await run(); } finally { off(); }
}

test("with a way in besides the browser, step 3 asks how they connect and hands over that link", async () => {
  const issued: unknown[] = [];
  await withInviteMethod({
    label: "Polyth app",
    detail: "Over Polyth Link.",
    available: ({ member }: { member: boolean }) => member ? true : "Only for Space members.",
    preferred: () => true,
    issue: async (input: unknown) => {
      issued.push(input);
      return { url: "https://polyth.app/join#v=1&t=abc", expiresAt: Date.UTC(2026, 11, 3), message: "Hi Iryna! Open https://polyth.app/join#v=1&t=abc", note: "Works once." };
    },
  }, async () => {
    const view = await mount();
    assert.match(view.panel().textContent ?? "", /Step 1 of 3/);
    const [name] = [...view.panel().querySelectorAll<HTMLInputElement>(".user-wizard-body input")];
    await view.type(name!, "Iryna Petrenko");
    await view.click(view.submit());
    assert.match(view.panel().textContent ?? "", /Step 2 of 3/);
    await view.click(view.submit());

    assert.match(view.panel().textContent ?? "", /Step 3 of 3/);
    assert.match(view.panel().textContent ?? "", /How will Iryna connect\?/);
    const methods = [...view.panel().querySelectorAll<HTMLElement>(".user-wizard-preset")].map((row) => row.dataset.method);
    assert.deepEqual(methods, ["test.app", "browser"]);
    // The preferred, available method is chosen; the browser names this address.
    assert.ok(view.panel().querySelector('.user-wizard-preset[data-method="test.app"][data-selected]'));
    assert.match(view.panel().querySelector('[data-method="browser"]')?.textContent ?? "", /https:\/\/polyth\.example\.org/);
    await view.click(view.submit());

    assert.deepEqual(issued, [{ member: true, shareableAddress: "https://polyth.example.org", accountId: "usr_new", name: "Iryna Petrenko" }]);
    assert.equal(calls.some((call) => call.path === "/api/auth/accounts/usr_new/invitation"), false, "no web link is made beside it");
    const text = view.panel().textContent ?? "";
    assert.match(text, /Connection link/);
    assert.ok(text.includes("https://polyth.app/join#v=1&t=abc"));
    assert.match(text, /Works once\./);
    assert.match(text, /Polyth on their device connects to this server/);
    assert.equal(view.panel().querySelector(".user-wizard-connect"), null, "no second Link offer");
    await view.unmount();
  });
});

test("a way in that doesn't fit the person stays visible but disabled, and the browser is chosen", async () => {
  await withInviteMethod({
    label: "Polyth app",
    detail: "Over Polyth Link.",
    available: ({ member }: { member: boolean }) => member ? true : "Only for Space members.",
    preferred: () => true,
    issue: async () => { throw new Error("must not be asked"); },
  }, async () => {
    const view = await mount();
    const [name] = [...view.panel().querySelectorAll<HTMLInputElement>(".user-wizard-body input")];
    await view.type(name!, "Iryna Petrenko");
    await view.click(view.submit());
    await view.click(view.panel().querySelector('.user-wizard-preset[data-preset="account"] input')!);
    await view.click(view.submit());

    const app = view.panel().querySelector<HTMLElement>('.user-wizard-preset[data-method="test.app"]')!;
    assert.equal(app.querySelector<HTMLInputElement>("input")!.disabled, true);
    assert.match(app.textContent ?? "", /Only for Space members\./);
    assert.ok(view.panel().querySelector('.user-wizard-preset[data-method="browser"][data-selected]'));
    await view.click(view.submit());
    assert.match(view.panel().textContent ?? "", /can sign in now/);
    await view.unmount();
  });
});

test("when the chosen way in fails, the person is still created and gets the password", async () => {
  await withInviteMethod({
    label: "Polyth app",
    detail: "Over Polyth Link.",
    preferred: () => true,
    issue: async () => { throw Object.assign(new Error("Polyth Link isn't running on this server."), { code: "unavailable" }); },
  }, async () => {
    const view = await mount();
    const [name] = [...view.panel().querySelectorAll<HTMLInputElement>(".user-wizard-body input")];
    await view.type(name!, "Iryna Petrenko");
    const password = view.panel().querySelectorAll<HTMLInputElement>(".user-wizard-body input")[2]!.value;
    await view.click(view.submit());
    await view.click(view.submit());
    await view.click(view.submit());

    const text = view.panel().textContent ?? "";
    assert.match(text, /the Polyth app invitation couldn’t be made/);
    assert.ok(text.includes(password), "the temporary password is the way in");
    assert.ok(calls.some((call) => call.path === "/api/auth/accounts/usr_new/invitation"), "the web link is still tried");
    await view.unmount();
  });
});
