import { test } from "node:test";
import assert from "node:assert/strict";
import { FALLBACK_LOGIN, LOGIN_PATTERN, loginFromName } from "../src/loginName.ts";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
}

test("setup proposes a login from the name, so nobody has to invent one", () => {
  for (const [name, login] of [
    ["Ida Lindqvist", "ida.lindqvist"],
    ["  José   Núñez ", "jose.nunez"],
    ["Сергій Коваленко", "serhiy.kovalenko"],
    ["Олена-Марія", "olena.mariya"],
    ["Ёлка", "yolka"],
    ["ann_o'neil 2", "ann.oneil.2"],
  ] as const) {
    const proposed = loginFromName(name);
    assert.ok(LOGIN_PATTERN.test(proposed), `${name} → ${proposed} passes the server rule`);
    assert.equal(proposed, login);
  }
  for (const empty of ["", "   ", "李雷", "🙂", "..."]) assert.equal(loginFromName(empty), FALLBACK_LOGIN, JSON.stringify(empty));
  assert.ok(loginFromName("a".repeat(200)).length <= 32);
});

test("the lock screen's saved accounts are this device's own, most recent first, bounded and deduplicated", async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  try {
    const { knownBrowserLogins, rememberBrowserLogin } = await import("../src/accounts.ts");
    assert.deepEqual(knownBrowserLogins(), [], "nothing until someone signs in here");
    storage.setItem("polyth.lastLogin", "owner");
    assert.deepEqual(knownBrowserLogins(), [{ login: "owner" }], "an older shell's last login still shows");
    rememberBrowserLogin("Owner", "Serhii");
    rememberBrowserLogin("guest");
    rememberBrowserLogin("owner");
    assert.deepEqual(knownBrowserLogins(), [{ login: "owner", name: "Serhii" }, { login: "guest" }], "a repeat moves up and keeps its name");
    for (let i = 0; i < 8; i += 1) rememberBrowserLogin(`user${i}`);
    assert.equal(knownBrowserLogins().length, 5);
    storage.setItem("polyth.knownLogins", JSON.stringify([{ login: "../etc" }, { login: 3 }, null, { login: "ok", name: 7 }]));
    assert.deepEqual(knownBrowserLogins(), [{ login: "ok" }], "damaged entries are skipped");
  } finally {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});
