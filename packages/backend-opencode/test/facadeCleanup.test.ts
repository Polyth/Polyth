import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEndpoint, RuntimeEvent } from "@polyth/contracts";
import { createOpenCodeRuntimeFacade } from "../src/index.ts";
import type { RuntimeLifecycle } from "../src/runtime.ts";

test("disposed facades ignore queued stream callbacks and preserve caller-owned bindings", async () => {
  const endpoint: RuntimeEndpoint = {
    authorityId: "cleanup", generation: 1, continuity: "verified",
    url: "http://fake.invalid", location: { directory: "/fixture" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" }, authentication: { kind: "none" },
  };
  const shared = new Map([["canonical", "backend"], ["foreign-canonical", "foreign-backend"]]);
  for (let cycle = 0; cycle < 100; cycle++) {
    let deliver!: Parameters<RuntimeLifecycle["streamEvents"]>[0];
    let connected!: () => void;
    const ready = new Promise<void>((resolve) => { connected = resolve; });
    let streams = 0;
    let refreshes = 0;
    const lifecycle = {
      endpoint: async () => endpoint,
      refresh: async () => { refreshes++; return endpoint; },
      streamEvents: async (input: typeof deliver) => {
        streams++;
        deliver = input;
        connected();
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    } as unknown as RuntimeLifecycle;
    const runtime = createOpenCodeRuntimeFacade({ cwd: "/fixture", lifecycle, sessionIdMap: shared, log: () => {} });
    const events: RuntimeEvent[] = [];
    runtime.onEvent((_id, event) => events.push(event));
    await ready;
    const send = (id: string) => deliver.onEvent({
      ...endpoint,
      value: { id, data: { type: "permission.asked", properties: { id, sessionID: "backend", permission: "read", patterns: ["fixture"] } } },
    });
    send("before");
    assert.equal(events.length, 1, "fixture must exercise a translated request");
    await runtime.dispose();
    runtime.onEvent((_id, event) => events.push(event));
    deliver.onOpen?.();
    deliver.onActivity?.();
    send("after");
    await Promise.resolve();
    assert.equal(events.length, 1, "queued callbacks cannot publish or retain listeners after dispose");
    assert.equal(deliver.signal.aborted, true);
    assert.equal(streams, 1);
    assert.equal(refreshes, 0);
    assert.equal(shared.size, 2, "a facade does not own the supplied canonical mapping");
  }
});
