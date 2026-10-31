// Settings "Send test": an expired own subscription is replaced and re-tested
// without a permission prompt, and the status line names expired/failed
// counts instead of a bare "Sent to 0 devices".
import assert from "node:assert/strict";
import test from "node:test";
import { describePushTest, sendTestPush } from "../src/push.ts";

const P256 = "B" + "A".repeat(85); // 65 bytes base64url, shape only

function installBrowser(serverReplies: Array<Record<string, unknown>>) {
  const saved = ["window", "navigator", "Notification", "fetch"].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const browserLog: string[] = [];
  let current: { endpoint: string } | null = { endpoint: "https://push.example.net/old" };
  let minted = 0;
  const makeSub = (endpoint: string) => ({
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: P256, auth: "AAAAAAAAAAAAAAAAAAAAAA" } }),
    unsubscribe: async () => { browserLog.push(`unsubscribe ${endpoint}`); current = null; return true; },
  });
  const reg = {
    pushManager: {
      getSubscription: async () => current && makeSub(current.endpoint),
      subscribe: async () => {
        minted++;
        current = { endpoint: `https://push.example.net/new-${minted}` };
        browserLog.push(`subscribe ${current.endpoint}`);
        return makeSub(current.endpoint);
      },
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { PushManager: class {}, isSecureContext: true } });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: { getRegistration: async () => reg, register: async () => reg } },
  });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: { permission: "granted", requestPermission: async () => { browserLog.push("prompt"); return "granted"; } },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      requests.push({ url: String(url), method, body: init?.body ? JSON.parse(init.body) : undefined });
      const path = new URL(String(url), "http://polyth.test").pathname;
      const value = path === "/api/push/test" ? serverReplies.shift()
        : path === "/api/push/key" ? { publicKey: P256, subscriptions: 1 }
        : { ok: true, subscriptions: 1 };
      return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return {
    requests,
    browserLog,
    restore() {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

test("an expired own subscription is renewed and the test resent to the fresh endpoint", async () => {
  const browser = installBrowser([
    { sent: 0, dropped: 1, failed: 0, ownDropped: true },
    { sent: 1, dropped: 0, failed: 0, ownDropped: false },
  ]);
  try {
    const result = await sendTestPush();
    assert.deepEqual(result, { sent: 1, dropped: 1, failed: 0, renewed: true });
    assert.deepEqual(browser.browserLog, ["unsubscribe https://push.example.net/old", "subscribe https://push.example.net/new-1"]);
    const tests = browser.requests.filter((r) => r.url.endsWith("/api/push/test")).map((r) => r.body);
    assert.deepEqual(tests, [{ endpoint: "https://push.example.net/old" }, { endpoint: "https://push.example.net/new-1" }]);
    assert.ok(browser.requests.some((r) => r.url.endsWith("/api/push/subscribe") && r.method === "POST"
      && (r.body as { endpoint?: string }).endpoint === "https://push.example.net/new-1"));
  } finally {
    browser.restore();
  }
});

test("another device's expiry or a failure leaves this browser's subscription alone", async () => {
  const browser = installBrowser([{ sent: 1, dropped: 1, failed: 1, ownDropped: false }]);
  try {
    assert.deepEqual(await sendTestPush(), { sent: 1, dropped: 1, failed: 1, renewed: false });
    assert.deepEqual(browser.browserLog, []);
    assert.equal(browser.requests.filter((r) => r.url.endsWith("/api/push/test")).length, 1);
  } finally {
    browser.restore();
  }
});

test("the status line names expired, failed and renewed subscriptions", () => {
  assert.equal(describePushTest({ sent: 1, dropped: 0, failed: 0, renewed: false }), "Sent to 1 device");
  assert.equal(
    describePushTest({ sent: 0, dropped: 2, failed: 1, renewed: false }),
    "Sent to 0 devices · 2 expired and removed · 1 failed (see the server log)",
  );
  assert.equal(
    describePushTest({ sent: 1, dropped: 1, failed: 0, renewed: true }),
    "Sent to 1 device · 1 expired and removed · This browser's expired subscription was renewed",
  );
});
