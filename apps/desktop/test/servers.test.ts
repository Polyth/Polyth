import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_SERVERS_STATE,
  isThisComputersServer,
  normalizeServerAddress,
  normalizeServersState,
  readServersStateSync,
  rememberAddress,
  sameTarget,
  startupPlan,
  writeServersState,
} from "../src/servers.ts";

test("an install with no choice yet runs its own server, as it always did", () => {
  assert.deepEqual(startupPlan(DEFAULT_SERVERS_STATE), { bootLocal: true, open: "local" });
  assert.deepEqual(normalizeServersState(undefined), DEFAULT_SERVERS_STATE);
  assert.deepEqual(normalizeServersState("nonsense"), DEFAULT_SERVERS_STATE);
  assert.deepEqual(readServersStateSync("/nonexistent/servers.json"), DEFAULT_SERVERS_STATE);
});

test("someone who only connects boots no server of their own", () => {
  const plan = startupPlan({ ...DEFAULT_SERVERS_STATE, active: { kind: "link", id: "abc" }, runLocalServer: false });
  assert.deepEqual(plan, { bootLocal: false, open: "server-list", connect: "abc" });
  assert.deepEqual(
    startupPlan({ ...DEFAULT_SERVERS_STATE, active: { kind: "address", url: "https://a.example" }, runLocalServer: false }),
    { bootLocal: false, open: "address" },
  );
});

test("a window on another server leaves this computer's agents running", () => {
  assert.equal(startupPlan({ ...DEFAULT_SERVERS_STATE, active: { kind: "link", id: "abc" } }).bootLocal, true);
});

test("the local server turned off while on screen waits for a choice", () => {
  assert.deepEqual(startupPlan({ ...DEFAULT_SERVERS_STATE, runLocalServer: false }), { bootLocal: false, open: "server-list" });
});

test("a server address is reduced to an origin", () => {
  assert.equal(normalizeServerAddress("polyth.example.com"), "https://polyth.example.com");
  assert.equal(normalizeServerAddress(" https://polyth.example.com/p/a?x=1#y "), "https://polyth.example.com");
  assert.equal(normalizeServerAddress("http://192.168.1.10:4400/"), "http://192.168.1.10:4400");
  for (const bad of ["", "   ", "ftp://a.example", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@a.example", 7, null, `https://${"a".repeat(3000)}`]) {
    assert.throws(() => normalizeServerAddress(bad), { code: "invalid-address" }, String(bad));
  }
});

test("a damaged file keeps what is still good", () => {
  const state = normalizeServersState({
    active: { kind: "link", id: "../../etc" },
    runLocalServer: "yes",
    linkPorts: { abc: 41234, "../x": 1, def: 99_999, ghi: "1" },
    addresses: [
      { url: "https://a.example/p", lastUsedAt: 5 },
      { url: "https://a.example", lastUsedAt: 6 },
      { url: "ftp://b.example" },
      "nonsense",
      { url: "b.example" },
    ],
    microphoneServers: ["link:abc", "other:x", 7],
  });
  assert.deepEqual(state, {
    active: { kind: "local" },
    runLocalServer: true,
    linkPorts: { abc: 41234 },
    addresses: [{ url: "https://a.example", lastUsedAt: 5 }, { url: "https://b.example", lastUsedAt: 0 }],
    microphoneServers: ["link:abc"],
  });
});

test("the list keeps the newest addresses first, without duplicates", () => {
  let state = DEFAULT_SERVERS_STATE;
  for (let index = 0; index < 12; index += 1) state = rememberAddress(state, `https://s${index}.example`, index);
  state = rememberAddress(state, "https://s10.example", 100);
  assert.equal(state.addresses[0]?.url, "https://s10.example");
  assert.equal(state.addresses.length, 8);
  assert.equal(new Set(state.addresses.map((address) => address.url)).size, 8);
});

test("targets compare by which server they are", () => {
  assert.equal(sameTarget({ kind: "local" }, { kind: "local" }), true);
  assert.equal(sameTarget({ kind: "link", id: "a" }, { kind: "link", id: "a" }), true);
  assert.equal(sameTarget({ kind: "link", id: "a" }, { kind: "link", id: "b" }), false);
  assert.equal(sameTarget({ kind: "address", url: "https://a" }, { kind: "address", url: "https://b" }), false);
  assert.equal(sameTarget({ kind: "local" }, { kind: "link", id: "a" }), false);
});

test("the file round-trips, private to this user, and an older build's missing file is fine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-servers-"));
  try {
    const path = join(dir, "nested", "servers.json");
    const state = { ...DEFAULT_SERVERS_STATE, active: { kind: "link" as const, id: "abc" }, runLocalServer: false, linkPorts: { abc: 41234 } };
    await writeServersState(path, state);
    assert.deepEqual(readServersStateSync(path), state);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).linkPorts, { abc: 41234 });
    await writeFile(path, "{ broken");
    assert.deepEqual(readServersStateSync(path), DEFAULT_SERVERS_STATE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("this computer's own server is recognised under any loopback name", () => {
  const local = "http://127.0.0.1:4400";
  assert.equal(isThisComputersServer("http://localhost:4400", local), true);
  assert.equal(isThisComputersServer("http://127.0.0.1:4400", local), true);
  assert.equal(isThisComputersServer("http://[::1]:4400", local), true);
  assert.equal(isThisComputersServer("http://localhost:8080", local), false);
  assert.equal(isThisComputersServer("https://localhost:4400", local), false);
  assert.equal(isThisComputersServer("http://polyth.example.com:4400", local), false);
  assert.equal(isThisComputersServer("http://localhost:4400", ""), false);
});
