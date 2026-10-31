import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import type { ServerPermissionWaitingEvent } from "@polyth/plugins";
import { createPermissionWaitingBus } from "../src/permissionWaiting.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("a waiting permission reaches every listener with whether the Space answers automatically", async () => {
  const projections: Record<string, Partial<SessionProjection>> = { open: { spaceId: "space-a" }, guarded: { spaceId: "space-g" } };
  const errors: unknown[] = [];
  const bus = createPermissionWaitingBus({
    projection: async (id) => projections[id] as SessionProjection | undefined,
    guardedSpace: (spaceId) => spaceId === "space-g",
    onError: (error) => errors.push(error),
  });
  const heard: ServerPermissionWaitingEvent[] = [];
  bus.publish("open", "r0");
  await settle();
  const first = bus.service.subscribe((event) => { heard.push(event); });
  // A failing listener neither stops the others nor reaches the session service.
  const failing = bus.service.subscribe(() => { throw new Error("listener broke"); });
  bus.publish("open", "r1");
  bus.publish("guarded", "r2");
  await settle();
  assert.deepEqual(heard, [
    { sessionId: "open", requestId: "r1", automaticAllowed: true },
    { sessionId: "guarded", requestId: "r2", automaticAllowed: false },
  ], "a publication before anyone listened is not replayed");
  assert.equal(errors.length, 2);
  first.dispose(); failing.dispose();
  bus.publish("open", "r3");
  await settle();
  assert.equal(heard.length, 2, "disposed listeners hear nothing");
});
