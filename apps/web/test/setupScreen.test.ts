import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { createDesktopSetupClaimBroker } from "../../desktop/src/setupClaim.ts";

// Mounted first-run setup: the real SetupScreen against a fake identity server
// with the canonical claim semantics (one browser binding, 15-minute expiry,
// rotation on re-issue) and, for Desktop, the real main-process claim broker.
// The regression it pins: a claim that expired while the person read their
// recovery codes surfaced as a dead-end "invalid claim" on Create.

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: () => ({ matches: false, media: "", addEventListener: () => {}, removeEventListener: () => {} }),
});
let reloads = 0;
let replaced: string[] = [];
Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: {
    href: "http://127.0.0.1:4400/",
    origin: "http://127.0.0.1:4400",
    reload: () => { reloads += 1; },
    replace: (url: string) => { replaced.push(url); },
  },
});

// Wall clock the fake server, the claim broker and the screen all share.
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const MINUTE = 60_000;

interface Claim { binding: string | null; expiresAt: number }
interface Call { path: string; body: Record<string, unknown> }
const server = {
  claims: new Map<string, Claim>(),
  recovery: null as { token: string; setId: string; codes: string[] } | null,
  calls: [] as Call[],
  offline: false,
  ready: false,
  serial: 0,
  issue() {
    // Issuing rotates out every unconsumed claim and prepared recovery set.
    server.claims.clear();
    server.recovery = null;
    server.serial += 1;
    const token = server.serial.toString(16).padStart(64, "c");
    const claim = { binding: null, expiresAt: Date.now() + 15 * MINUTE };
    server.claims.set(token, claim);
    return { token, expiresAt: claim.expiresAt };
  },
  reset() {
    server.claims.clear();
    server.recovery = null;
    server.calls = [];
    server.offline = false;
    server.ready = false;
  },
};
const BROWSER = "browser-binding";
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const valid = (token: unknown): Claim | null => {
  const claim = typeof token === "string" ? server.claims.get(token) : undefined;
  if (!claim || claim.expiresAt <= Date.now() || (claim.binding && claim.binding !== BROWSER)) return null;
  return claim;
};

Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (server.offline) throw new TypeError("Failed to fetch");
    if (path === "/api/auth/status") {
      return json(200, { required: true, authorized: false, scope: "anonymous", state: "uninitialized", csrfToken: "f".repeat(64) });
    }
    if (path === "/api/auth/me") return json(200, { id: "usr_owner" });
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    server.calls.push({ path, body });
    if (server.ready) return json(409, { error: "setup-completed" });
    if (path === "/api/auth/setup/claim") {
      const claim = valid(body.claimToken);
      if (!claim) return json(401, { error: "invalid-claim" });
      claim.binding = BROWSER;
      return json(200, { expiresAt: claim.expiresAt });
    }
    if (path === "/api/auth/setup/recovery") {
      if (!valid(body.claimToken)) return json(401, { error: "invalid-claim" });
      server.serial += 1;
      const codes = Array.from({ length: 8 }, (_, index) => `${server.serial}${index}`.padStart(40, "d"));
      server.recovery = { token: String(body.claimToken), setId: `rcv_${server.serial}`, codes };
      return json(200, { setId: server.recovery.setId, codes });
    }
    if (path === "/api/auth/setup/complete") {
      if (!valid(body.claimToken)) return json(401, { error: "invalid-claim" });
      if (server.recovery?.setId !== body.recoverySetId || body.recoveryAcknowledged !== true) {
        return json(400, { error: "recovery-ack-required" });
      }
      server.ready = true;
      return json(200, { ok: true, csrfToken: "e".repeat(64) });
    }
    return json(404, { error: "not-found" });
  },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: SetupScreen } = await import("../src/components/SetupScreen.tsx");
const { clearAuthCsrf } = await import("../src/authClient.ts");
const { tr } = await import("../src/i18n/index.ts");

const flush = async () => {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

interface DesktopStub {
  requests: unknown[];
  restarts: number;
  localSetups: number;
}

/** `local`: a current shell that can finish first run without a password;
 *  without it, an older shell that only knows the account flow. */
function installDesktop(options: { local?: { ok: true } | { ok: false; error: string } } = {}): DesktopStub {
  const stub: DesktopStub = { requests: [], restarts: 0, localSetups: 0 };
  const broker = createDesktopSetupClaimBroker(() => server.issue(), () => Date.now());
  (dom as unknown as { polythDesktop?: unknown }).polythDesktop = {
    requestSetupClaim: async (request?: { fresh?: boolean }) => {
      stub.requests.push(request);
      return broker.request({ fresh: request?.fresh === true });
    },
    restartAfterSetup: async () => { stub.restarts += 1; },
    ...(options.local ? {
      completeLocalSetup: async () => {
        stub.localSetups += 1;
        // The main process ends any half-finished browser setup.
        if (options.local!.ok) { server.claims.clear(); server.recovery = null; server.ready = true; }
        return options.local;
      },
    } : {}),
  };
  return stub;
}

// A mount is one renderer lifetime; the desktop stub (main process) outlives it.
async function mount(props: Record<string, unknown> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(SetupScreen, props)); });
  await flush();
  return {
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

const $ = <T extends Element = HTMLElement>(selector: string): T | null => document.body.querySelector<T>(selector);
const text = (): string => document.body.textContent ?? "";
const typeInto = async (selector: string, value: string) => {
  const input = $<HTMLInputElement>(selector);
  assert.ok(input, `${selector} exists`);
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
};
const click = async (target: Element | null) => {
  assert.ok(target, "click target exists");
  await act(async () => { (target as HTMLElement).click(); });
  await flush();
};
const submitButton = (): HTMLButtonElement | null => $<HTMLButtonElement>("form.lock-card button[type=submit]");
const codesShown = (): string[] =>
  [...document.body.querySelectorAll(".setup-codes .setup-code")].map((code) => code.textContent ?? "");

async function fillAccount() {
  await typeInto("#setup-name", "Ida Lindqvist");
  await typeInto("#setup-password", "correct horse battery");
}

test.beforeEach(() => {
  server.reset();
  skew = 0;
  reloads = 0;
  replaced = [];
  clearAuthCsrf();
});
test.afterEach(() => {
  delete (dom as unknown as { polythDesktop?: unknown }).polythDesktop;
});

test("desktop setup asks only for a name and a password, then shows recovery codes", async () => {
  const desktop = installDesktop();
  const view = await mount();
  try {
    assert.ok($("#setup-name"), "the account step opens first");
    assert.ok($("#setup-password"));
    for (const removed of ["#setup-claim", "#setup-organization", "#setup-confirm", "#setup-login"]) {
      assert.equal($(removed) === null, true, `${removed} is not asked`);
    }
    assert.doesNotMatch(text(), /npm run setup:claim/);
    assert.equal(desktop.requests.length, 0, "no claim is issued before the person continues");
    assert.equal(submitButton()?.disabled, true, "Continue waits for both fields");

    await fillAccount();
    assert.equal(submitButton()?.disabled, false);
    await click(submitButton());

    assert.equal(desktop.requests.length, 1);
    assert.equal(codesShown().length, 8);
    assert.equal(codesShown()[0], server.recovery!.codes[0], "a displayed code copies as one unbroken string");
    assert.equal(submitButton()?.disabled, true, "Create waits for the saved-codes acknowledgement");

    await click($(".lock-agree input"));
    await click(submitButton());

    const complete = server.calls.find((call) => call.path === "/api/auth/setup/complete");
    assert.ok(complete, "setup completed");
    assert.equal(complete.body.login, "owner");
    assert.equal(complete.body.organizationName, "Personal");
    assert.equal(complete.body.name, "Ida Lindqvist");
    assert.equal(complete.body.recoveryAcknowledged, true);
    assert.equal(desktop.restarts, 1, "Desktop restarts into the workspace on its own");
    assert.equal(reloads, 1);
  } finally {
    await view.unmount();
  }
});

const usageOptions = (): HTMLInputElement[] => [...document.body.querySelectorAll<HTMLInputElement>(".setup-usage input[type=radio]")];
const chooseUsage = async (value: string) => {
  const option = usageOptions().find((input) => input.value === value);
  assert.ok(option, `${value} is offered`);
  await click(option);
};

test("desktop first asks how Polyth will be used; alone starts without any password", async () => {
  const desktop = installDesktop({ local: { ok: true } });
  const view = await mount();
  try {
    assert.deepEqual(usageOptions().map((input) => input.value), ["solo", "devices", "people"]);
    assert.equal(usageOptions()[0]!.checked, true, "just me is the default");
    assert.equal($("#setup-name"), null, "no name is typed: it comes from the OS account");
    assert.equal($("#setup-password"), null, "no password is asked");
    assert.ok($(".setup-steps[data-hidden]"), "a one-step start shows no progress dots");
    await click(submitButton());
    assert.equal(desktop.localSetups, 1);
    assert.equal(desktop.requests.length, 0, "no setup claim is needed");
    assert.equal(server.calls.length, 0, "nothing goes through the HTTP setup routes");
    assert.equal(desktop.restarts, 1, "Desktop restarts into the workspace on its own");
    assert.equal(reloads, 1);
    assert.deepEqual(replaced, []);
  } finally {
    await view.unmount();
  }
});

test("\"from my phone too\" starts without a password and opens Polyth Link", async () => {
  const desktop = installDesktop({ local: { ok: true } });
  const view = await mount();
  try {
    await chooseUsage("devices");
    await click(submitButton());
    assert.equal(desktop.localSetups, 1);
    assert.equal(desktop.restarts, 1);
    assert.deepEqual(replaced, ["/?settings=tunnel"]);
    assert.equal(reloads, 0);
  } finally {
    await view.unmount();
  }
});

test("\"with other people\" continues to the owner account; Back returns to the choice", async () => {
  const desktop = installDesktop({ local: { ok: true } });
  const view = await mount();
  try {
    await chooseUsage("people");
    assert.equal($(".setup-steps[data-hidden]"), null, "the three steps show");
    assert.equal(document.body.querySelectorAll(".setup-step-dot").length, 3);
    await click(submitButton());
    assert.ok($("#setup-name"), "the account step follows");
    assert.equal(desktop.localSetups, 0);
    await click($(".setup-back"));
    assert.equal(usageOptions().find((input) => input.checked)?.value, "people", "the choice is kept");
    await click(submitButton());
    await fillAccount();
    await click(submitButton());
    assert.equal(codesShown().length, 8);
    await click($(".lock-agree input"));
    await click(submitButton());
    assert.equal(server.calls.find((call) => call.path === "/api/auth/setup/complete")?.body.login, "owner");
    assert.equal(desktop.localSetups, 0, "people always get a password");
    assert.equal(desktop.restarts, 1);
  } finally {
    await view.unmount();
  }
});

test("a password-less start that finds Polyth already set up offers sign-in", async () => {
  const desktop = installDesktop({ local: { ok: false, error: "setup-completed" } });
  const view = await mount();
  try {
    await click(submitButton());
    assert.equal(desktop.localSetups, 1);
    assert.equal(desktop.restarts, 0);
    assert.match(text(), new RegExp(tr("setup.error.alreadySetUp")));
    assert.ok([...document.body.querySelectorAll("button")].some((button) => button.textContent === tr("setup.signIn")));
  } finally {
    await view.unmount();
  }
});

test("desktop recovers when the claim expired while the codes were open", async () => {
  const desktop = installDesktop();
  const view = await mount();
  try {
    await fillAccount();
    await click(submitButton());
    const firstCodes = codesShown();
    assert.equal(firstCodes.length, 8);
    await click($(".lock-agree input"));

    skew += 16 * MINUTE; // the person took a while to store the codes
    await click(submitButton());

    assert.equal(server.ready, false, "the stale codes did not create the account");
    assert.doesNotMatch(text(), /invalid claim/i);
    assert.ok($(".setup-notice"), "the person is told the codes were replaced");
    const renewed = codesShown();
    assert.equal(renewed.length, 8);
    assert.notDeepEqual(renewed, firstCodes);
    assert.equal(($(".lock-agree input") as HTMLInputElement).checked, false, "the new codes need a new acknowledgement");
    assert.equal($(".lock-error"), null, "no error banner for a recovered claim");

    await click($(".lock-agree input"));
    await click(submitButton());
    assert.equal(server.ready, true);
    assert.equal(desktop.restarts, 1);
  } finally {
    await view.unmount();
  }
});

test("desktop replaces a cached claim the server refuses after a renderer reload", async () => {
  const desktop = installDesktop();
  const first = await mount();
  await fillAccount();
  await click(submitButton());
  assert.equal(codesShown().length, 8);
  await first.unmount();
  // The reloaded renderer presents a different browser binding (its cookie
  // was lost), so the main process's still-live cached claim is refused.
  for (const claim of server.claims.values()) claim.binding = "previous-renderer";
  const second = await mount();
  try {
    await fillAccount();
    await click(submitButton());
    assert.equal(codesShown().length, 8, "codes come from a replacement claim");
    assert.deepEqual(desktop.requests, [{ fresh: false }, { fresh: false }, { fresh: true }]);
    assert.equal($(".lock-error"), null);
  } finally {
    await second.unmount();
  }
});

test("Back then Continue keeps codes that may already be saved", async () => {
  installDesktop();
  const view = await mount();
  try {
    await fillAccount();
    await click(submitButton());
    const codes = codesShown();
    const recoveryCalls = () => server.calls.filter((call) => call.path === "/api/auth/setup/recovery").length;
    assert.equal(recoveryCalls(), 1);
    await click($(".setup-back"));
    await typeInto("#setup-name", "Ida");
    await click(submitButton());
    assert.deepEqual(codesShown(), codes);
    assert.equal(recoveryCalls(), 1);
  } finally {
    await view.unmount();
  }
});

test("server setup: setup code, account, codes; an expired code returns to the first step", async () => {
  const view = await mount();
  try {
    assert.ok($("#setup-claim"), "a standalone server asks for the operator's setup code first");
    assert.match(text(), /npm run setup:claim/);
    assert.equal(submitButton()?.disabled, true);
    await typeInto("#setup-claim", "not-a-code");
    assert.ok($("#setup-claim[aria-invalid=true]"), "a malformed code is flagged inline");

    const issued = server.issue();
    await typeInto("#setup-claim", `  ${issued.token.toUpperCase()}\n`);
    await click(submitButton());
    assert.ok($("#setup-name"), "a pasted code with whitespace is accepted");

    await fillAccount();
    await click(submitButton());
    assert.equal(codesShown().length, 8);
    await click($(".lock-agree input"));

    skew += 16 * MINUTE;
    await click(submitButton());
    assert.ok($("#setup-claim"), "an expired code returns to the setup-code step");
    assert.match($(".lock-error")?.textContent ?? "", /expired/);
    assert.doesNotMatch(text(), /invalid claim/i);

    const fresh = server.issue();
    await typeInto("#setup-claim", fresh.token);
    await click(submitButton());
    assert.equal(($("#setup-name") as HTMLInputElement).value, "Ida Lindqvist", "the account details survive");
    await click(submitButton());
    await click($(".lock-agree input"));
    await click(submitButton());
    assert.equal(server.ready, true);
    assert.match(text(), /Restart the Polyth server/);
  } finally {
    await view.unmount();
  }
});

test("errors are sentences, never raw codes", async () => {
  installDesktop();
  const view = await mount();
  try {
    await fillAccount();
    server.offline = true;
    await click(submitButton());
    const banner = $(".lock-error")?.textContent ?? "";
    assert.match(banner, /Couldn’t reach Polyth/);
    assert.doesNotMatch(banner, /HTTP|network|invalid/);
    assert.ok($("#setup-name"), "the person stays on the account step");

    server.offline = false;
    server.ready = true;
    await click(submitButton());
    assert.match($(".lock-error")?.textContent ?? "", /already set up/);
    assert.ok($(".lock-error button"), "already-set-up offers a way to sign in");
  } finally {
    await view.unmount();
  }
});

test("setup offers the interface language up front and switches it without losing what was typed", async () => {
  const i18n = await import("../src/i18n/index.ts");
  installDesktop();
  const view = await mount();
  try {
    const picker = () => $<HTMLButtonElement>(".lock-screen-bar .language-picker");
    assert.ok(picker(), "the language is offered above the setup card");
    assert.equal(picker()!.textContent, "English", "it names the current language");
    assert.equal(picker()!.getAttribute("aria-label"), "Language: English");

    await fillAccount();
    server.offline = true;
    await click(submitButton());
    assert.match($(".lock-error")?.textContent ?? "", /Couldn’t reach Polyth/);

    await click(picker());
    const ukrainian = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitemradio"]')]
      .find((item) => item.textContent?.trim() === i18n.LOCALE_NAMES.uk);
    assert.ok(ukrainian, "every language is listed by its own name");
    await click(ukrainian);
    await act(async () => { await i18n.ensureLocale("uk"); });
    await flush();

    assert.equal(i18n.getLocale(), "uk");
    assert.equal(picker()!.textContent, i18n.LOCALE_NAMES.uk);
    assert.equal($("#setup-title")?.textContent, tr("setup.account.title"), "the step re-renders in Ukrainian");
    assert.notEqual(tr("setup.account.title"), "Welcome to Polyth");
    assert.equal(($("#setup-name") as HTMLInputElement).value, "Ida Lindqvist", "the typed name survives the switch");
    assert.equal(($("#setup-password") as HTMLInputElement).value, "correct horse battery");
    assert.equal($(".lock-error")?.textContent, tr("setup.error.network"), "an open error follows the language too");
  } finally {
    await act(async () => { await i18n.setLocale("system"); });
    await view.unmount();
  }
});

test("a desktop restart-required state finishes on its own", async () => {
  const desktop = installDesktop();
  const view = await mount({ restartRequired: true });
  try {
    assert.equal(desktop.restarts, 1);
    assert.equal(reloads, 1);
  } finally {
    await view.unmount();
  }
});
