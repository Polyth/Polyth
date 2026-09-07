import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { AuthAttemptDto } from "@polyth/contracts";

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

const { act, createElement, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useProviderAuthAttempt } = await import("../widgets/useProviderAuthAttempt.ts");
const { api } = await import("@polyth/session/web-api");

const waiting = (id: string): AuthAttemptDto => ({
  id,
  providerId: "acme",
  methodId: "acme:0:fp",
  upstreamIndex: 0,
  fingerprint: "fp",
  revision: "rev",
  authorityId: "local",
  generation: 1,
  phase: "browser_action_required",
  createdAt: 1,
});

const connected = (id: string): AuthAttemptDto => ({
  ...waiting(id),
  phase: "connected",
});

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function Probe({
  restored,
  onConnected,
}: {
  restored?: AuthAttemptDto;
  onConnected: () => void;
}) {
  const { attempt, watching } = useProviderAuthAttempt({
    restored,
    onConnected,
    onMethodError: () => {},
  });
  useEffect(() => {
    (globalThis as { __probe?: { phase?: string; watching?: boolean } }).__probe = {
      phase: attempt?.phase,
      watching,
    };
  });
  return createElement("div", {
    "data-phase": attempt?.phase ?? "",
    "data-watching": watching ? "1" : "0",
  });
}

test("unmounting and remounting resumes observation until connected", async () => {
  const polls: string[] = [];
  let phase: AuthAttemptDto["phase"] = "browser_action_required";
  api.providerAuthAttempt = async (id: string) => {
    polls.push(id);
    return phase === "connected" ? connected(id) : waiting(id);
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  let connectedCount = 0;
  let root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe, {
      restored: waiting("attempt-1"),
      onConnected: () => { connectedCount += 1; },
    }));
    await delay(30);
  });
  assert.ok(polls.includes("attempt-1"));
  const afterFirst = polls.length;

  await act(async () => { root.unmount(); });
  await delay(40);
  const afterUnmount = polls.length;

  root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe, {
      restored: waiting("attempt-1"),
      onConnected: () => { connectedCount += 1; },
    }));
    await delay(30);
  });
  assert.ok(polls.length > afterUnmount, "remount must poll again");
  assert.ok(afterUnmount - afterFirst <= 1, "unmount must stop the poller");

  phase = "connected";
  await act(async () => { await delay(1600); });
  assert.equal(connectedCount, 1);
  await act(async () => { root.unmount(); });
  container.remove();
});

function MutationProbe({
  onConnected,
  onReady,
}: {
  onConnected: () => void;
  onReady: (setAttempt: (next: AuthAttemptDto | null) => void) => void;
}) {
  const { setAttempt } = useProviderAuthAttempt({
    onConnected,
    onMethodError: () => {},
  });
  useEffect(() => { onReady(setAttempt); }, [onReady, setAttempt]);
  return createElement("div");
}

test("adopting a configured_unverified mutation result calls onConnected once", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let connectedCount = 0;
  let setAttempt!: (next: AuthAttemptDto | null) => void;
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(MutationProbe, {
      onConnected: () => { connectedCount += 1; },
      onReady: (next) => { setAttempt = next; },
    }));
    await delay(20);
  });
  const terminal: AuthAttemptDto = {
    ...waiting("attempt-api"),
    phase: "configured_unverified",
  };
  await act(async () => {
    setAttempt(terminal);
    setAttempt(terminal);
    await delay(10);
  });
  assert.equal(connectedCount, 1);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("terminal AUTH errors stop polling and clear the live attempt", async () => {
  let polls = 0;
  api.providerAuthAttempt = async () => {
    polls += 1;
    throw Object.assign(new Error("Sign-in session expired or is no longer active."), { code: "AUTH_SESSION_STALE", status: 422 });
  };
  const errors: string[] = [];
  function ErrorProbe() {
    const { attempt } = useProviderAuthAttempt({
      restored: waiting("attempt-stale"),
      onConnected: () => {},
      onMethodError: (_id, error) => { errors.push(error.code); },
    });
    return createElement("div", { "data-phase": attempt?.phase ?? "" });
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ErrorProbe));
    await delay(40);
  });
  const afterFirst = polls;
  await act(async () => { await delay(1800); });
  assert.equal(polls, afterFirst);
  assert.deepEqual(errors, ["AUTH_SESSION_STALE"]);
  assert.equal(container.querySelector("[data-phase]")?.getAttribute("data-phase"), "");
  await act(async () => { root.unmount(); });
  container.remove();
});
