// Behavioral guard for `sendMessage` delivery routing. The two code paths are
// not interchangeable: normal/queue stage a durable recovery intent and flush
// it before crossing the network (so a crash cannot lose the message), while
// steer/interrupt must go straight to the API without a turn-submit intent (or
// "Send now" would stop interrupting and could be admitted as a duplicate turn).
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

type Wire = { sessionId: string; body: Record<string, unknown> };

test("sendMessage routes delivery through the path that owns durable intent", async () => {
  const { sendMessage } = await import("../src/init.ts");
  const { api } = await import("@polyth/session/web-api");
  const { readClientRecord, setClientPersistenceBackend } = await import("../src/clientPersistence.ts");
  const { clientPersistenceScope } = await import("../src/reliabilityContext.ts");

  const wire: Wire[] = [];
  let intentAtSend: string | null = null;
  const originalSend = api.sendMessage;
  const originalError = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => { logged.push(args[1]); };
  api.sendMessage = (async (sessionId: string, body: Record<string, unknown>) => {
    wire.push({ sessionId, body });
    intentAtSend = readClientRecord("unsent-intent", clientPersistenceScope({ sessionId }));
    return { ok: true };
  }) as unknown as typeof api.sendMessage;

  const intentKind = (raw: string | null): string | undefined => {
    if (!raw) return undefined;
    return (JSON.parse(raw) as { kind?: string }).kind;
  };

  try {
    const cases = [
      { delivery: undefined, wireDelivery: undefined, operation: true, kind: "turn-submit" },
      { delivery: "normal", wireDelivery: "normal", operation: true, kind: "turn-submit" },
      { delivery: "queue", wireDelivery: "queue", operation: true, kind: "queue-admission" },
      { delivery: "steer", wireDelivery: "steer", operation: false, kind: undefined },
      { delivery: "interrupt", wireDelivery: "interrupt", operation: false, kind: undefined },
    ] as const;

    for (const variant of cases) {
      wire.length = 0;
      intentAtSend = null;
      const sessionId = `sess-${variant.delivery ?? "default"}`;
      const ok = await sendMessage("hello", undefined, undefined, {
        targetSessionId: sessionId,
        ...(variant.delivery ? { delivery: variant.delivery } : {}),
      });
      assert.equal(ok, true, `delivery=${variant.delivery}: send should succeed`);
      assert.equal(wire.length, 1, `delivery=${variant.delivery}: exactly one network send`);
      const body = wire[0]!.body;

      if (variant.wireDelivery === undefined) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(body, "delivery"),
          false,
          `delivery=${variant.delivery}: an undefined delivery must be absent from the wire`,
        );
      } else {
        assert.equal(body.delivery, variant.wireDelivery, `delivery=${variant.delivery}: wire delivery`);
      }

      if (variant.operation) {
        assert.equal(typeof body.clientOperationId, "string", `delivery=${variant.delivery}: clientOperationId must be present`);
        assert.equal(intentKind(intentAtSend), variant.kind, `delivery=${variant.delivery}: persisted intent kind`);
        assert.equal(
          readClientRecord("unsent-intent", clientPersistenceScope({ sessionId })),
          null,
          `delivery=${variant.delivery}: a completed send clears its recovery intent`,
        );
      } else {
        assert.equal(body.clientOperationId, undefined, `delivery=${variant.delivery}: direct path must not carry a clientOperationId`);
        assert.equal(intentKind(intentAtSend), undefined, `delivery=${variant.delivery}: direct path must not stage a recovery intent`);
        assert.equal(
          readClientRecord("unsent-intent", clientPersistenceScope({ sessionId })),
          null,
          `delivery=${variant.delivery}: direct path leaves no recovery intent`,
        );
      }
    }

    // The pre-network flush is the whole point: if durable recovery metadata
    // cannot be written, normal/queue must never reach the API.
    setClientPersistenceBackend({
      get: async () => null,
      set: async () => { throw new Error("recovery metadata could not be persisted"); },
      remove: async () => {},
    });
    for (const delivery of [undefined, "normal", "queue"] as const) {
      wire.length = 0;
      const ok = await sendMessage("hello", undefined, undefined, {
        targetSessionId: `sess-flush-${delivery ?? "default"}`,
        ...(delivery ? { delivery } : {}),
      });
      assert.equal(ok, false, `delivery=${delivery}: a failed pre-network flush must fail the send`);
      assert.equal(wire.length, 0, `delivery=${delivery}: the API must not be called before the intent is durable`);
    }

    // A stale captured reliability scope must not be sent from the direct path.
    wire.length = 0;
    const staleScope = { connectionScope: "stale-origin", accountId: "stale-account", spaceId: "default" };
    const ok = await sendMessage("hello", undefined, undefined, {
      targetSessionId: "sess-stale",
      delivery: "steer",
      reliabilityScope: staleScope,
    });
    assert.equal(ok, false, "a stale scope must fail the send");
    assert.equal(wire.length, 0, "a stale scope must not reach the network");
    const failure = logged.find((entry) => (entry as { code?: string })?.code === "client-context-changed");
    assert.ok(failure, "the failure must be client-context-changed");
  } finally {
    api.sendMessage = originalSend;
    console.error = originalError;
    setClientPersistenceBackend(null);
  }
});
