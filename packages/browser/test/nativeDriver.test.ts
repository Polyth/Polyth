import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createNativeDriver, findChromiumExecutable, type DriverFrame, type DriverPage, type DriverPageEvent } from "../src/index.ts";
import { createFixtureHost, type Fixture, type FixtureView } from "./support/nativeHostFixture.ts";

const executable = await findChromiumExecutable();
const skip = executable ? false : "no Chromium executable found (set POLYTH_CHROMIUM_PATH)";

// The page reports its own state through console when the fixed #dump button is
// clicked, so tests read it through the driver's public event stream.
const PAGE = `<!doctype html><html><head><title>Native fixture</title></head><body style="margin:0;font:16px sans-serif">
<button id="dump" style="position:fixed;top:0;right:0">Dump</button>
<h1>Native fixture</h1>
<input id="name" value="old value"><input id="pw" type="password" value="hunter2secret"><input id="plain" value="visible-input-value">
<div><button id="b1">Alpha</button> <button id="b2" aria-label="Beta role">Beta</button> <a id="link" href="/two">Go two</a>
<button id="popup" onclick="window.open('/popup-target')">Pop</button>
<button id="dl" onclick="location.href='/file.bin'">Download</button>
<button id="fetch" onclick="fetch('/secret').then(()=>console.log('FETCH:ok'),()=>console.log('FETCH:blocked'))">Fetch</button></div>
<select id="sel"><option value="a">A</option><option value="b">Bee</option></select>
<form id="f"><input id="q" name="q"></form>
<div style="height:3000px"></div><p id="bottom">bottom</p>
<script>
const clicks = [];
document.addEventListener('click', (e) => clicks.push({ id: e.target.id, trusted: e.isTrusted }), true);
let submitted = null; let selected = null; let keys = [];
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); submitted = document.getElementById('q').value; });
document.getElementById('sel').addEventListener('change', (e) => { selected = e.target.value; });
document.addEventListener('keydown', (e) => keys.push(e.key), true);
document.getElementById('dump').addEventListener('click', () => console.log('DUMP:' + JSON.stringify({
  clicks, submitted, selected, keys,
  name: document.getElementById('name').value, q: document.getElementById('q').value,
  scrollY: Math.round(scrollY), w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
  dark: matchMedia('(prefers-color-scheme: dark)').matches,
})));
</script></body></html>`;

let server: Server;
let origin = "";
let fixture: Fixture;

before(async () => {
  if (skip) return;
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    const html = (body: string) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(body); };
    if (url === "/file.bin") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=f.bin" });
      res.end("data");
    } else if (url === "/secret") {
      res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
      res.end("secret");
    } else if (url === "/popup-target") html("<title>Popup</title><p>popup page</p>");
    else if (url === "/two") html("<title>Two</title><h1>Page two</h1>");
    else if (url === "/forbidden") html("<h1>forbidden</h1>");
    else if (url === "/redirect") { res.writeHead(302, { Location: "/forbidden" }); res.end(); }
    else html(PAGE);
  });
  origin = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
  fixture = await createFixtureHost(executable!);
});

after(async () => {
  if (skip) return;
  await fixture.dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Opened { page: DriverPage; view: FixtureView; events: DriverPageEvent[] }

const openPage = async (guardEgress = true): Promise<Opened> => {
  const driver = createNativeDriver(fixture.host);
  assert.equal(driver.engine, "chromium");
  assert.equal(driver.native, true);
  const page = await driver.open({
    width: 800,
    height: 600,
    deviceScaleFactor: 2,
    colorScheme: "light",
    guardNavigation: async (url) => {
      if (url.endsWith("/forbidden")) throw new Error("navigation to /forbidden is blocked");
    },
    ...(guardEgress ? {
      guardNetworkEgress: async (url: string) => {
        if (url.endsWith("/secret")) throw new Error("egress to /secret is blocked");
      },
    } : {}),
  });
  const events: DriverPageEvent[] = [];
  page.onEvent((e) => events.push(e));
  return { page, view: fixture.views.at(-1)!, events };
};

interface Dump {
  clicks: Array<{ id: string; trusted: boolean }>;
  submitted: string | null;
  selected: string | null;
  keys: string[];
  name: string;
  q: string;
  scrollY: number;
  w: number;
  h: number;
  dpr: number;
  dark: boolean;
}

const dump = async (page: DriverPage, events: DriverPageEvent[]): Promise<Dump> => {
  const before = events.length;
  await page.click({ selector: "#dump" });
  const found = events.slice(before).find((e) => e.kind === "console" && e.message?.startsWith("DUMP:"));
  assert.ok(found, "page did not report its state");
  return JSON.parse(found.message!.slice(5)) as Dump;
};

const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
};

test("goto, current and observe never expose input or password values", { skip }, async () => {
  const { page, view, events } = await openPage();
  try {
    const nav = await page.goto(`${origin}/`);
    assert.equal(nav.title, "Native fixture");
    assert.equal(page.current().url, `${origin}/`);
    const obs = await page.observe();
    assert.match(obs.text, /Native fixture/);
    assert.doesNotMatch(obs.text, /hunter2secret|visible-input-value|old value/);
    assert.doesNotMatch(obs.accessibilityDigest, /hunter2secret|visible-input-value|old value/);
    assert.match(obs.accessibilityDigest, /button "Alpha"/);
    assert.ok(events.some((e) => e.kind === "navigation" && e.url === `${origin}/`));
    assert.deepEqual(view.parkedSizes[0], { width: 800, height: 600 });
    assert.equal((await page.observe("h1")).text, "Native fixture");
    assert.equal((await page.inspect("#b1")).tag, "button");
    const rect = (await page.targetRect!({ selector: "#b1" }))!;
    assert.ok(rect.width > 0 && rect.height > 0);
    assert.equal((await page.point({ x: rect.x + 2, y: rect.y + 2 })).selector, "#b1");
    assert.ok(((await page.queryRegion!({ x: 0, y: 0, width: 300, height: 100 })).elements.length) > 0);
    const range = await page.textRange!({ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y });
    assert.equal(typeof range.quote, "string");
    assert.equal(page.nativeViewId, view.id);
  } finally {
    await page.close();
  }
});

test("clicks by selector, text, role and point are trusted events with focus metadata", { skip }, async () => {
  const { page, events } = await openPage();
  try {
    await page.goto(`${origin}/`);
    await page.click({ selector: "#b1" });
    await page.click({ text: "Beta", exact: true });
    await page.click({ role: "button", name: "Beta role" });
    const rect = (await page.targetRect!({ selector: "#b2" }))!;
    await page.click({ point: { x: rect.x + 3, y: rect.y + 3 }, frameRevision: 1 });
    const input = (await page.targetRect!({ selector: "#plain" }))!;
    const meta = (await page.click({ point: { x: input.x + 4, y: input.y + 4 }, frameRevision: 1 }))! as Record<string, unknown>;
    assert.equal(meta.editable, true);
    assert.equal(meta.selector, "#plain");
    const state = await dump(page, events);
    const ids = state.clicks.map((c) => c.id);
    assert.deepEqual(ids.slice(0, 5), ["b1", "b2", "b2", "b2", "plain"]);
    assert.ok(state.clicks.every((c) => c.trusted), "every click must be isTrusted");
    // Non-exact text is a case-insensitive substring match.
    await page.click({ text: "go TWO" });
    assert.equal(page.current().url, `${origin}/two`);
    await assert.rejects(() => page.click({ role: "button", name: "does not exist" }), /Timeout/);
  } finally {
    await page.close();
  }
});

test("type replaces existing text with Cyrillic and submits; press handles chords", { skip }, async () => {
  const { page, events } = await openPage();
  try {
    await page.goto(`${origin}/`);
    await page.type({ selector: "#name" }, "Привіт, світ");
    await page.type({ selector: "#q" }, "запит 42", true);
    let state = await dump(page, events);
    assert.equal(state.name, "Привіт, світ");
    assert.equal(state.q, "запит 42");
    assert.equal(state.submitted, "запит 42");
    await page.type({ selector: "#name" }, "");
    assert.equal((await dump(page, events)).name, "");
    // Control+A then Backspace clears a focused field.
    await page.type({ selector: "#name" }, "abcdef");
    await page.click({ selector: "#name" });
    await page.press("Control+A");
    await page.press("Backspace");
    state = await dump(page, events);
    assert.equal(state.name, "");
    await page.type({ selector: "#name" }, "z");
    await page.press("Shift+Tab");
    await page.press("ArrowLeft");
    const keys = (await dump(page, events)).keys;
    assert.ok(keys.includes("Tab") && keys.includes("ArrowLeft") && keys.includes("Backspace"));
    await assert.rejects(() => page.press("NoSuchKey"), /Unknown key/);
    // Password fields can be typed into but never show up in observations.
    await page.type({ selector: "#pw" }, "new-secret-pass");
    assert.doesNotMatch((await page.observe()).text + (await page.observe()).accessibilityDigest, /new-secret-pass/);
  } finally {
    await page.close();
  }
});

test("select, scroll, back and forward", { skip }, async () => {
  const { page, events } = await openPage();
  try {
    await page.goto(`${origin}/`);
    await page.select({ selector: "#sel" }, "b");
    assert.equal((await dump(page, events)).selected, "b");
    await page.select({ selector: "#sel" }, "A");
    assert.equal((await dump(page, events)).selected, "a");
    await assert.rejects(() => page.select({ selector: "#sel" }, "nope"), /options/);
    await page.scroll(0, 600);
    assert.ok((await dump(page, events)).scrollY >= 500);
    await page.scroll(0, 0, { selector: "#bottom" });
    assert.ok((await dump(page, events)).scrollY >= 2500);
    await page.goto(`${origin}/two`);
    assert.equal(page.current().title, "Two");
    assert.equal((await page.back()).url, `${origin}/`);
    assert.equal((await page.forward()).url, `${origin}/two`);
    assert.equal((await page.reload()).url, `${origin}/two`);
    await page.wait("network-idle", undefined, 5000);
    await page.wait("selector", "h1", 2000);
    await assert.rejects(() => page.wait("selector", "#nope", 300), /Timeout/);
  } finally {
    await page.close();
  }
});

test("guards refuse navigation and subresource requests, including redirects", { skip }, async () => {
  const { page, events } = await openPage();
  try {
    await page.goto(`${origin}/`);
    await assert.rejects(() => page.goto(`${origin}/forbidden`), /\/forbidden is blocked/);
    await assert.rejects(() => page.goto(`${origin}/redirect`), /\/forbidden is blocked/);
    assert.ok(events.some((e) => e.kind === "navigation" && e.message?.startsWith("blocked:")));
    await page.goto(`${origin}/`);
    await page.click({ selector: "#fetch" });
    await until(() => events.some((e) => e.kind === "console" && e.message === "FETCH:blocked"));
    assert.ok(events.some((e) => e.kind === "network" && e.message?.startsWith("blocked:")));
  } finally {
    await page.close();
  }
});

test("without a network egress guard every subresource is refused", { skip }, async () => {
  const { page, events } = await openPage(false);
  try {
    await page.goto(`${origin}/`);
    await page.click({ selector: "#fetch" });
    await until(() => events.some((e) => e.kind === "console" && e.message === "FETCH:blocked"));
    assert.ok(events.some((e) => e.kind === "network" && /egress guard unavailable/.test(e.message ?? "")));
  } finally {
    await page.close();
  }
});

test("screenshots, clips and screencast frames are jpeg", { skip }, async () => {
  const { page } = await openPage();
  try {
    await page.goto(`${origin}/`);
    const shot = await page.screenshot();
    assert.equal(shot.mime, "image/jpeg");
    assert.ok(shot.data.length > 500);
    assert.deepEqual([...shot.data.slice(0, 3)], [0xff, 0xd8, 0xff]);
    const clip = await page.screenshotClip!({ x: 0, y: 0, width: 100, height: 60 });
    assert.deepEqual([...clip.data.slice(0, 3)], [0xff, 0xd8, 0xff]);
    assert.ok(clip.data.length < shot.data.length);
    const frames: DriverFrame[] = [];
    const off = page.onFrame!((f) => frames.push(f));
    await page.startScreencast!({ quality: 50, maxWidth: 400, maxHeight: 300 });
    await page.scroll(0, 50);
    await until(() => frames.length > 0);
    assert.equal(frames[0]!.mime, "image/jpeg");
    await page.stopScreencast!();
    off();
  } finally {
    await page.close();
  }
});

test("resize, device scale factor and color scheme emulation; a shown view keeps its window size", { skip }, async () => {
  const { page, view, events } = await openPage();
  try {
    await page.goto(`${origin}/`);
    let state = await dump(page, events);
    assert.deepEqual([state.w, state.h, state.dpr, state.dark], [800, 600, 2, false]);
    await page.resize({ width: 500, height: 400 });
    state = await dump(page, events);
    assert.deepEqual([state.w, state.h], [500, 400]);
    assert.deepEqual(view.parkedSizes.at(-1), { width: 500, height: 400 });
    await page.emulateColorScheme("dark");
    assert.equal((await dump(page, events)).dark, true);
    await page.emulateColorScheme("light");
    assert.equal((await dump(page, events)).dark, false);
    // While shown, the window decides the size: the override must be cleared.
    const shown: Array<{ shown: boolean; width?: number; height?: number }> = [];
    const off = page.onNativeShown!((s) => shown.push(s));
    view.setShown(true);
    await until(() => shown.length === 1);
    assert.equal(shown[0]!.shown, true);
    assert.equal(typeof shown[0]!.width, "number");
    await page.resize({ width: 300, height: 300 });
    assert.notEqual((await dump(page, events)).w, 300);
    view.setShown(false);
    await until(() => shown.length === 2);
    assert.equal((await dump(page, events)).w, 300);
    // Without a request while shown, stepping back keeps the size the window
    // gave the page (the host parks it at that size): no reflow behind a menu.
    view.setShown(true);
    await until(() => shown.length === 3);
    const shownWidth = (await dump(page, events)).w;
    view.setShown(false);
    await until(() => shown.length === 4);
    assert.equal((await dump(page, events)).w, shownWidth);
    // The page never emulates a pixel ratio: it keeps the screen's.
    assert.equal((await dump(page, events)).dpr, 2);
    off();
  } finally {
    await page.close();
  }
});

test("popups and downloads are reported, window.open navigates the main page", { skip }, async () => {
  const { page, view, events } = await openPage();
  try {
    await page.goto(`${origin}/`);
    await page.click({ selector: "#popup" });
    await until(() => events.some((e) => e.kind === "popup-blocked"));
    await until(() => page.current().url === `${origin}/popup-target`);
    await page.goto(`${origin}/`);
    view.blockDownload(`${origin}/file.bin?token=abc`);
    const download = events.find((e) => e.kind === "download-blocked");
    assert.ok(download && download.message === "downloads are blocked");
  } finally {
    await page.close();
  }
});

test("a crash is reported, calls then fail as context-closed, and close removes every listener", { skip }, async () => {
  const crashed = await openPage();
  await crashed.page.goto(`${origin}/`);
  await crashed.view.crash();
  await until(() => crashed.events.some((e) => e.kind === "crash"));
  await assert.rejects(() => crashed.page.observe(), (error: Error & { code?: string }) => error.code === "context-closed");
  await crashed.page.close();
  assert.equal(crashed.view.listenerCount(), 0);

  const open = await openPage();
  await open.page.goto(`${origin}/`);
  await open.page.startScreencast!({ quality: 40, maxWidth: 200, maxHeight: 200 });
  assert.ok(open.view.listenerCount() > 0);
  await open.page.close();
  assert.equal(open.view.listenerCount(), 0);
  await assert.rejects(() => open.page.screenshot(), (error: Error & { code?: string }) => error.code === "context-closed");
  await open.page.close(); // idempotent
});
