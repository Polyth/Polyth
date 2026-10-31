import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import type { AuthPrincipal, AuthResolution } from "@polyth/contracts";
import {
  defaultWsIdentity,
  liveWsPrincipal,
  normalizeWsAttachAuth,
} from "../src/wsAttach.ts";

type Identified = AuthPrincipal & { userId: string };
const request = {} as IncomingMessage;
const session = (userId = "usr_a"): Identified => ({
  kind: "ui-session",
  sessionId: "ses_live",
  rememberedDeviceId: "browser",
  userId,
} as Identified);

test("bound websocket session is rejected immediately after credential revocation", () => {
  let live = true;
  const auth = normalizeWsAttachAuth({
    identity: (): AuthResolution => live
      ? { principal: session(), authenticated: true }
      : { principal: { kind: "anonymous" }, authenticated: false },
    refreshPrincipal: (principal) => principal,
  });
  const initial = defaultWsIdentity(auth, request);
  assert.equal(liveWsPrincipal(initial.principal, auth.refreshPrincipal)?.kind, "ui-session");
  live = false;
  assert.equal(liveWsPrincipal(initial.principal, auth.refreshPrincipal), null);
});

test("revalidation cannot switch the account behind an already-bound socket", () => {
  let userId = "usr_a";
  const auth = normalizeWsAttachAuth({
    identity: (): AuthResolution => ({ principal: session(userId), authenticated: true }),
  });
  const initial = defaultWsIdentity(auth, request);
  userId = "usr_b";
  assert.equal(liveWsPrincipal(initial.principal, auth.refreshPrincipal), null);
});

test("transport-specific refresh remains an additional revocation fence", () => {
  let transportLive = true;
  const auth = normalizeWsAttachAuth({
    identity: (): AuthResolution => ({ principal: session(), authenticated: true }),
    refreshPrincipal: (principal) => transportLive ? principal : null,
  });
  const initial = defaultWsIdentity(auth, request);
  assert.ok(liveWsPrincipal(initial.principal, auth.refreshPrincipal));
  transportLive = false;
  assert.equal(liveWsPrincipal(initial.principal, auth.refreshPrincipal), null);
});
