import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PersistedRuntimeBinding,
  RuntimeEndpoint,
} from "@polyth/contracts";
import { canRebindPersistedSession } from "../src/sessions.ts";

const endpoint: RuntimeEndpoint = {
  authorityId: "owned:runtime-a",
  continuity: "verified",
  generation: 2,
  url: "http://127.0.0.1:4402",
  location: { directory: "/project", workspace: "main" },
  control: { kind: "owned", instanceToken: "instance-2" },
  config: { kind: "read-only" },
  authentication: { kind: "none" },
};

const persisted: PersistedRuntimeBinding = {
  backendSessionId: "backend-a",
  authorityId: endpoint.authorityId,
  continuity: "verified",
  generation: 1,
  protocol: "legacy",
  location: endpoint.location,
};

const canRebind = (
  binding: PersistedRuntimeBinding,
  current: RuntimeEndpoint = endpoint,
): boolean => canRebindPersistedSession(binding, {
  backendSessionId: "backend-a",
  endpoint: current,
  protocol: "legacy",
});

// Lock the continuity verifier to authority/backend/location/generation
// semantics. Epoch replacement is a separate durable API and must never be
// smuggled into or used to relax this predicate.
test("rebind verifier remains epoch-unaware", () => {
  assert.doesNotMatch(canRebindPersistedSession.toString(), /\.epoch\b/);
});

test("verified durable authority can rebind the same backend session across generations", () => {
  assert.equal(canRebind(persisted), true);
});

test("equal generation does not require verified continuity", () => {
  assert.equal(canRebind({
    ...persisted,
    generation: endpoint.generation,
    continuity: "generation-only",
  }, {
    ...endpoint,
    continuity: "generation-only",
  }), true);
});

test("generation mismatch requires verified continuity on both bindings", () => {
  assert.equal(canRebind({ ...persisted, continuity: "generation-only" }), false);
  assert.equal(canRebind(persisted, { ...endpoint, continuity: "generation-only" }), false);
});

test("persisted backend session cannot move to another runtime identity", () => {
  assert.equal(canRebind({ ...persisted, authorityId: "owned:runtime-b" }), false);
  assert.equal(canRebind({ ...persisted, backendSessionId: "backend-b" }), false);
  assert.equal(canRebind({
    ...persisted,
    location: { ...persisted.location, directory: "/other-project" },
  }), false);
  assert.equal(canRebind({
    ...persisted,
    location: { ...persisted.location, workspace: "other" },
  }), false);
});

test("protocol upgrades retain durable backend-session identity", () => {
  assert.equal(canRebind({ ...persisted, protocol: "v2" }), true);
});

test("a replacement epoch cannot rebind through the old durable binding", () => {
  const replacementEndpoint: RuntimeEndpoint = {
    ...endpoint,
    authorityId: "owned:runtime-b",
    generation: 1,
    control: { kind: "owned", instanceToken: "replacement-instance" },
  };
  assert.equal(canRebindPersistedSession(persisted, {
    backendSessionId: "backend-epoch-1",
    endpoint: replacementEndpoint,
    protocol: "legacy",
  }), false);
});
