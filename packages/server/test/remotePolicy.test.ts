import test from "node:test";
import assert from "node:assert/strict";
import { REMOTE_CAPABILITY, type RemoteAccessPolicy } from "@polyth/contracts";
import {
  CORE_REMOTE_ACCESS,
  findRemoteHttpRule,
  findRemotePolicyOverlaps,
  validateRemoteAccessPolicy,
  type OwnedRemotePolicy,
} from "../src/remotePolicy.ts";

const rule = (
  methods: RemoteAccessPolicy["http"][number]["methods"],
  path: string,
  capability = REMOTE_CAPABILITY.coreSessionsRead,
  extra: Partial<RemoteAccessPolicy["http"][number]> = {},
): RemoteAccessPolicy["http"][number] => ({
  methods,
  path,
  capability,
  mutation: methods.some((method) => method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE"),
  ...extra,
});

test("core remote policy validates including static/dynamic queue routes with identical semantics", () => {
  validateRemoteAccessPolicy("core", CORE_REMOTE_ACCESS);
  const order = findRemoteHttpRule(
    [{ owner: "core", policy: CORE_REMOTE_ACCESS }],
    "PATCH",
    "/api/sessions/s1/queue/order",
  );
  assert.equal(order?.rule.path, "/api/sessions/:id/queue/order");
  const item = findRemoteHttpRule(
    [{ owner: "core", policy: CORE_REMOTE_ACCESS }],
    "PATCH",
    "/api/sessions/s1/queue/item-1",
  );
  assert.equal(item?.rule.path, "/api/sessions/:id/queue/:itemId");
});

test("static/dynamic overlap is rejected when capabilities differ", () => {
  assert.throws(
    () => validateRemoteAccessPolicy("alpha", {
      routeScopes: ["items"],
      http: [
        rule(["GET"], "/api/items/:id", REMOTE_CAPABILITY.filesRead),
        rule(["GET"], "/api/items/special", REMOTE_CAPABILITY.filesWrite),
      ],
    }),
    (error: Error & { code?: string }) => error.code === "invalid-input" && /overlaps/.test(error.message),
  );
});

test("partial HTTP method overlap is rejected when intersecting methods differ in capability", () => {
  const overlapping: OwnedRemotePolicy[] = [{
    owner: "alpha",
    policy: {
      routeScopes: ["items"],
      http: [
        rule(["GET", "POST"], "/api/items/:id", REMOTE_CAPABILITY.filesRead),
        rule(["POST", "DELETE"], "/api/items/special", REMOTE_CAPABILITY.filesWrite),
      ],
    },
  }];
  assert.ok(findRemotePolicyOverlaps(overlapping).some((row) => row.includes("POST")));
  const disjoint: OwnedRemotePolicy[] = [{
    owner: "alpha",
    policy: {
      routeScopes: ["items"],
      http: [
        rule(["GET", "POST"], "/api/items/:id", REMOTE_CAPABILITY.filesRead),
        rule(["DELETE"], "/api/items/special", REMOTE_CAPABILITY.filesWrite),
      ],
    },
  }];
  assert.deepEqual(findRemotePolicyOverlaps(disjoint), []);
});

test("unknown capability in a manifest is rejected", () => {
  assert.throws(
    () => validateRemoteAccessPolicy("gadget", {
      routeScopes: ["gadget"],
      http: [{
        methods: ["GET"],
        path: "/api/gadget/status",
        capability: "gadget.explode" as never,
        mutation: false,
      }],
    }),
    (error: Error & { code?: string }) => error.code === "invalid-input" && /capability is invalid/.test(error.message),
  );
});

test("safe methods cannot be marked as mutations and mutating methods must be", () => {
  assert.throws(
    () => validateRemoteAccessPolicy("gadget", {
      routeScopes: ["gadget"],
      http: [{
        methods: ["GET"],
        path: "/api/gadget/status",
        capability: REMOTE_CAPABILITY.coreHealthRead,
        mutation: true,
      }],
    }),
    /marks a safe method as a mutation/,
  );
  assert.throws(
    () => validateRemoteAccessPolicy("gadget", {
      routeScopes: ["gadget"],
      http: [{
        methods: ["POST"],
        path: "/api/gadget/status",
        capability: REMOTE_CAPABILITY.coreHealthRead,
        mutation: false,
      }],
    }),
    /missing mutation: true/,
  );
});

test("matching does not depend on policy registration order", () => {
  const files: OwnedRemotePolicy = {
    owner: "files",
    policy: {
      routeScopes: ["files"],
      http: [rule(["POST"], "/api/files/write", REMOTE_CAPABILITY.filesWrite)],
    },
  };
  const core: OwnedRemotePolicy = { owner: "core", policy: CORE_REMOTE_ACCESS };
  const forward = findRemoteHttpRule([core, files], "POST", "/api/files/write");
  const reverse = findRemoteHttpRule([files, core], "POST", "/api/files/write");
  assert.equal(forward?.owner, "files");
  assert.equal(reverse?.owner, "files");
  assert.equal(findRemoteHttpRule([files, core], "GET", "/api/does-not-exist"), null);
});
