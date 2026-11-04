// The phone app turns native push on by itself after it connects, once per
// server and account; a user who turns it off in Settings keeps it off.
import assert from "node:assert/strict";
import test from "node:test";

const SUB = `sub_${"A".repeat(22)}`;
const TOKEN = "ab".repeat(32);
const native = { mapping: false, enables: 0 };
let registered: string | null = null;

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  },
  // A native iOS shell with the PolythPush plugin, answered here.
  CapacitorCustomPlatform: { name: "ios" },
  Capacitor: {
    PluginHeaders: [{
      name: "PolythPush",
      methods: ["getStatus", "enable", "disable", "setForeground", "consumePendingOpen"].map((name) => ({ name, rtype: "promise" })),
    }],
    nativePromise: async (_plugin: string, method: string) => {
      if (method === "getStatus") {
        return native.mapping
          ? { state: "enabled", subscriptionId: SUB, providerToken: TOKEN, environment: "production" }
          : { state: "disabled" };
      }
      if (method === "enable") { native.enables++; native.mapping = true; return { subscriptionId: SUB, providerToken: TOKEN, environment: "production" }; }
      if (method === "disable") { native.mapping = false; return { ok: true }; }
      return {};
    },
  },
  fetch: async (_path: string, init: RequestInit) => {
    if (init.method === "POST") registered = JSON.parse(String(init.body)).subscriptionId;
    if (init.method === "DELETE") registered = null;
    return Response.json({ enabled: true, subscribed: registered !== null, subscriptionId: registered ?? undefined, ok: true });
  },
});

const push = await import("../src/nativePush.ts");

test("turned off in Settings stays off", async () => {
  await push.disableNativePushForCurrentAccount();
  await push.autoEnableNativePush();
  assert.equal(native.enables, 0);
  assert.equal(registered, null);
});

test("enables once after connecting, then leaves it to Settings", async () => {
  store.clear(); // a fresh install
  await push.autoEnableNativePush();
  assert.equal(native.enables, 1);
  assert.equal(registered, SUB);

  native.mapping = false; // e.g. the OS dropped the registration
  await push.autoEnableNativePush();
  assert.equal(native.enables, 1, "already settled: no second enable");
});
