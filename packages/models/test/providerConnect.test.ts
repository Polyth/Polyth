import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { AuthAttemptDto, ProviderAuthView } from "@polyth/contracts";
import { normalizeAuthMethod } from "../src/auth/index.ts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ProviderConnect } = await import("../widgets/ProviderConnect.tsx");
const { api } = await import("@polyth/session/web-api");

const method = normalizeAuthMethod({ type: "oauth", label: "Sign in", upstreamIndex: 0 }, "acme");

const waiting = (id: string): AuthAttemptDto => ({
  id,
  providerId: "acme",
  methodId: method.id,
  upstreamIndex: 0,
  fingerprint: method.fingerprint,
  revision: "rev",
  authorityId: "local",
  generation: 1,
  phase: "browser_action_required",
  createdAt: 1,
  url: "https://example.test/oauth/authorize",
  urlKind: "authorization",
  instructions: "Continue in the browser",
});

const view = (attempt?: AuthAttemptDto): ProviderAuthView => ({
  providerId: "acme",
  discovery: {
    status: "loaded",
    provenance: ["opencode-plugin"],
    revision: "rev",
    authorityId: "local",
    generation: 1,
  },
  methods: [method],
  ...(attempt ? { activeAttempt: attempt } : {}),
});

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("stale poll error removes the live authorization panel and keeps Start again", async () => {
  let polls = 0;
  api.providerAuthAttempt = async () => {
    polls += 1;
    throw Object.assign(new Error("Sign-in session expired or is no longer active."), {
      code: "AUTH_SESSION_STALE",
      status: 422,
    });
  };
  let started = 0;
  api.startProviderAuthAttempt = async () => {
    started += 1;
    return waiting("attempt-retry");
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ProviderConnect, {
      providerId: "acme",
      view: view(waiting("attempt-stale")),
      onConnected: () => {},
    }));
    await delay(50);
  });

  assert.equal(polls > 0, true);
  const afterFirst = polls;
  await act(async () => { await delay(1800); });
  assert.equal(polls, afterFirst, "must not keep polling a terminal attempt");

  const html = container.textContent ?? "";
  assert.equal(container.querySelector(".provider-connect-authorization"), null);
  assert.equal(container.querySelector("a.provider-auth-url"), null);
  assert.equal(html.includes("Waiting for authorization"), false);
  assert.equal(html.includes("Complete sign-in"), false);
  assert.match(html, /Sign-in session expired or is no longer active/);
  assert.equal(html.includes("Cancel"), false);
  const startAgain = [...container.querySelectorAll("button")].find((button) => button.textContent === "Start again");
  assert.ok(startAgain, "Start again must remain actionable");
  await act(async () => {
    startAgain!.dispatchEvent(new window.Event("click", { bubbles: true }));
    await delay(20);
  });
  assert.equal(started, 1);
  await act(async () => { root.unmount(); });
  container.remove();
});
