// A tapped phone notification opens its chat: the id is read from the landing
// address before boot rewrites it, and a brief failure right after the app
// reconnects does not lose the tap.
import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_PUSH_BOOT_WAIT_MS,
  NATIVE_PUSH_OPEN_RETRY_MS,
  landedNativePushOpen,
  nativePushTaps,
  offerNativePushBootTarget,
  openNativePushTarget,
  takeNativePushBootTarget,
  withoutNativePushOpen,
  type NativePushOpenDeps,
} from "../src/nativePushOpen.ts";

const ID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function deps(over: Partial<NativePushOpenDeps> = {}) {
  const log: string[] = [];
  const all: NativePushOpenDeps = {
    registered: async () => true,
    record: async () => ({ sessionId: "chat-1" }),
    open: async (sessionId) => { log.push(`open ${sessionId}`); },
    markRead: async (id) => { log.push(`read ${id}`); },
    wait: async (ms) => { log.push(`wait ${ms}`); },
    ...over,
  };
  return { all, log };
}

test("the landing address names the tapped notification only by a canonical id", () => {
  assert.equal(landedNativePushOpen(`?nativePushOpen=${ID}`), ID);
  assert.equal(landedNativePushOpen(`?nativePushOpen=${ID.toUpperCase()}`), ID);
  assert.equal(landedNativePushOpen(""), undefined);
  assert.equal(landedNativePushOpen("?session=chat-1"), undefined);
  assert.equal(landedNativePushOpen("?nativePushOpen=chat-1"), undefined);
  assert.equal(landedNativePushOpen(`?nativePushOpen=${ID}/../x`), undefined);
});

test("the id read at load survives the address boot restoration writes", async () => {
  // The app lands on the tap's address...
  const page = { href: `http://127.0.0.1:4100/?nativePushOpen=${ID}` };
  const landed = landedNativePushOpen(new URL(page.href).search);
  // ...boot restores the last chat and makes the address match it...
  page.href = "http://127.0.0.1:4100/p/project-1/s/last-chat";
  assert.equal(landedNativePushOpen(new URL(page.href).search), undefined, "a reader that waits for hydration finds nothing");
  // ...and the tap still opens its own chat.
  const { all, log } = deps({ record: async (id) => ({ sessionId: id === ID ? "tapped-chat" : "wrong" }) });
  assert.equal(await openNativePushTarget(landed!, all), "opened");
  assert.deepEqual(log, ["open tapped-chat", `read ${ID}`]);
});

test("cleaning the address removes only the tap's id", () => {
  assert.equal(withoutNativePushOpen(`http://127.0.0.1:4100/?nativePushOpen=${ID}`), "/");
  assert.equal(withoutNativePushOpen(`http://127.0.0.1:4100/p/a?tab=files&nativePushOpen=${ID}#x`), "/p/a?tab=files#x");
  assert.equal(withoutNativePushOpen("http://127.0.0.1:4100/p/a/s/b"), undefined, "nothing to clean: the restored address stays");
});

test("a moment without the server or the registration is retried, not dropped", async () => {
  let registered = 0;
  let reads = 0;
  const { all, log } = deps({
    registered: async () => ++registered > 1,
    record: async () => (++reads > 1 ? { sessionId: "chat-1" } : "unreachable"),
  });
  assert.equal(await openNativePushTarget(ID, all), "opened");
  assert.deepEqual(log, [`wait ${NATIVE_PUSH_OPEN_RETRY_MS[0]}`, `wait ${NATIVE_PUSH_OPEN_RETRY_MS[1]}`, "open chat-1", `read ${ID}`]);
});

test("a thrown check counts as a failed try", async () => {
  let tries = 0;
  const { all, log } = deps({
    registered: async () => { if (++tries === 1) throw new Error("offline"); return true; },
  });
  assert.equal(await openNativePushTarget(ID, all), "opened");
  assert.deepEqual(log, [`wait ${NATIVE_PUSH_OPEN_RETRY_MS[0]}`, "open chat-1", `read ${ID}`]);
});

test("the tries are bounded", async () => {
  let reads = 0;
  const { all, log } = deps({ record: async () => { reads++; return "unreachable"; } });
  assert.equal(await openNativePushTarget(ID, all), "dropped");
  assert.equal(reads, NATIVE_PUSH_OPEN_RETRY_MS.length + 1);
  assert.deepEqual(log, NATIVE_PUSH_OPEN_RETRY_MS.map((ms) => `wait ${ms}`));
});

test("a row the server does not hand out opens nothing and is not asked for again", async () => {
  let reads = 0;
  const { all, log } = deps({ record: async () => { reads++; return "gone"; } });
  assert.equal(await openNativePushTarget(ID, all), "dropped");
  assert.equal(reads, 1);
  assert.deepEqual(log, []);
});

test("without a confirmed registration the inbox is never read", async () => {
  let reads = 0;
  const { all } = deps({ registered: async () => false, record: async () => { reads++; return { sessionId: "chat-1" }; } });
  assert.equal(await openNativePushTarget(ID, all), "dropped");
  assert.equal(reads, 0);
});

test("a chat that can no longer be opened leaves the restored screen and its row unread", async () => {
  const { all, log } = deps({ open: async () => { throw new Error("not found"); } });
  assert.equal(await openNativePushTarget(ID, all), "opened");
  assert.deepEqual(log, []);
});

const never = (): Promise<void> => new Promise(() => {});

test("the launch lands on the tapped chat when its inbox row answers in time", async () => {
  offerNativePushBootTarget(Promise.resolve("chat-9"));
  assert.equal(await takeNativePushBootTarget(never), "chat-9");
  assert.equal(await takeNativePushBootTarget(never), undefined, "taken once");
});

test("a launch without a tap restores at once", async () => {
  const waits: number[] = [];
  assert.equal(await takeNativePushBootTarget(async (ms) => { waits.push(ms); }), undefined);
  assert.deepEqual(waits, [], "an ordinary launch never waits for a tap");
});

test("a slow inbox row does not hold the launch", async () => {
  const waits: number[] = [];
  offerNativePushBootTarget(new Promise(() => {}));
  assert.equal(await takeNativePushBootTarget(async (ms) => { waits.push(ms); }), undefined);
  assert.deepEqual(waits, [NATIVE_PUSH_BOOT_WAIT_MS]);
});

test("a failed inbox read leaves the launch on the remembered chat", async () => {
  offerNativePushBootTarget(Promise.reject(new Error("offline")));
  assert.equal(await takeNativePushBootTarget(never), undefined);
});

const OTHER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

test("a tap announced to the running page is claimed, opened once and settled", async () => {
  const log: string[] = [];
  let held: string | undefined = ID;
  const taps = nativePushTaps({
    claim: async () => held,
    open: async (id) => { log.push(`open ${id}`); },
    settle: async (id) => { log.push(`settle ${id}`); held = undefined; },
  });
  // Announced by the native event and found again by the check after boot.
  await Promise.all([taps.take(), taps.take()]);
  assert.deepEqual(log.filter((line) => line.startsWith("open")), [`open ${ID}`]);
  assert.equal(log.at(-1), `settle ${ID}`);
  await taps.take();
  assert.equal(log.filter((line) => line.startsWith("open")).length, 1, "a settled tap is not held any more");
});

test("a second tap is claimed while the first is still opening", async () => {
  const log: string[] = [];
  const held = [ID, OTHER];
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const taps = nativePushTaps({
    claim: async () => { const id = held.shift(); log.push(`claim ${id}`); return id; },
    open: async (id) => { log.push(`open ${id}`); if (id === ID) await gate; },
    settle: async (id) => { log.push(`settle ${id}`); },
  });
  const first = taps.take();
  await new Promise((resolve) => setImmediate(resolve));
  const second = taps.take();
  await new Promise((resolve) => setImmediate(resolve));
  // Unclaimed, the native app would send the second tap through the hub.
  assert.deepEqual(log, [`claim ${ID}`, `open ${ID}`, `claim ${OTHER}`]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(log.slice(3), [`settle ${ID}`, `open ${OTHER}`, `settle ${OTHER}`]);
});

test("a tap in hand from the landing address is opened and settled without a claim", async () => {
  const log: string[] = [];
  const taps = nativePushTaps({
    claim: async () => { log.push("claim"); return undefined; },
    open: async (id) => { log.push(`open ${id}`); },
    settle: async (id) => { log.push(`settle ${id}`); },
  });
  await taps.open(ID);
  assert.deepEqual(log, [`open ${ID}`, `settle ${ID}`]);
});

test("nothing held opens nothing, and a failed open still releases the tap", async () => {
  const log: string[] = [];
  let held: string | undefined;
  const taps = nativePushTaps({
    claim: async () => held,
    open: async () => { throw new Error("no such chat"); },
    settle: async (id) => { log.push(`settle ${id}`); },
  });
  await taps.take();
  assert.deepEqual(log, []);
  held = ID;
  await taps.take();
  assert.deepEqual(log, [`settle ${ID}`]);
});
