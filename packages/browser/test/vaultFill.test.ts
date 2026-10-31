import test from "node:test";
import assert from "node:assert/strict";
import {
  createBrowserVaultFillBroker,
  type BrowserVaultFillRequest,
} from "../src/vaultFill.ts";

const input = {
  browserSessionId: "browser-a",
  sessionId: "session-a",
  projectId: "project-a",
  handle: "UI_PASSWORD",
  label: "Polyth UI password",
  origin: "https://example.com",
  selector: "#password",
  submit: false,
};

test("vault fill broker blocks until one explicit allow and exposes metadata only", async () => {
  let requested: BrowserVaultFillRequest | undefined;
  const outcomes: string[] = [];
  const broker = createBrowserVaultFillBroker({
    onRequested: (request) => { requested = request; },
    onResolved: (_request, outcome) => { outcomes.push(outcome); },
  });

  let settled = false;
  const approval = broker.request(input).then(() => { settled = true; });
  await Promise.resolve();

  assert.ok(requested);
  assert.equal(settled, false);
  assert.deepEqual(broker.list("browser-a"), [requested]);
  assert.doesNotMatch(JSON.stringify(requested), /secret|plaintext|value/i);
  assert.equal(broker.resolve(requested!.id, "allow"), true);
  await approval;
  assert.equal(settled, true);
  assert.deepEqual(outcomes, ["allow"]);
  assert.equal(broker.resolve(requested!.id, "allow"), false);
});

test("vault fill broker deny, abort, and browser close all fail closed", async () => {
  const broker = createBrowserVaultFillBroker();
  const denied = broker.request(input);
  await Promise.resolve();
  const deniedRequest = broker.list("browser-a")[0]!;
  broker.resolve(deniedRequest.id, "deny");
  await assert.rejects(
    denied,
    (cause: Error & { code?: string }) => cause.code === "credential-denied",
  );

  const controller = new AbortController();
  const aborted = broker.request({ ...input, browserSessionId: "browser-b" }, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(
    aborted,
    (cause: Error & { code?: string }) => cause.code === "aborted",
  );

  const cancelled = broker.request({ ...input, browserSessionId: "browser-c" });
  await Promise.resolve();
  broker.cancelForBrowserSession("browser-c");
  await assert.rejects(
    cancelled,
    (cause: Error & { code?: string }) => cause.code === "credential-approval-cancelled",
  );
});

test("a browser closed during request publication cannot acquire a late pending approval", async () => {
  let broker = createBrowserVaultFillBroker();
  broker = createBrowserVaultFillBroker({
    onRequested: (request) => {
      broker.cancelForBrowserSession(request.browserSessionId);
    },
  });
  await assert.rejects(
    broker.request({ ...input, browserSessionId: "browser-race" }),
    (cause: Error & { code?: string }) => cause.code === "credential-approval-cancelled",
  );
  assert.deepEqual(broker.list("browser-race"), []);
});

test("a persisted grant resolves the next fill without publishing a prompt", async () => {
  let requested = false;
  const outcomes: string[] = [];
  const broker = createBrowserVaultFillBroker({
    shouldAutoAllow: (request) => request.spaceId === "space-a"
      && request.projectId === "project-a"
      && request.handle === "UI_PASSWORD"
      && request.origin === "https://example.com",
    onRequested: () => { requested = true; },
    onResolved: (_request, outcome) => { outcomes.push(outcome); },
  });
  await broker.request({ ...input, spaceId: "space-a" });
  assert.equal(requested, false);
  assert.deepEqual(outcomes, ["auto-allow"]);
  assert.deepEqual(broker.list(), []);
});
