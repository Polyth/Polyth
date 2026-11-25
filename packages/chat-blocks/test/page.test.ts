// The ```page fence: the sandboxed document builder, fence parsing and the
// message protocol. Security-relevant properties are pinned here.
import test from "node:test";
import assert from "node:assert/strict";
import {
  PAGE_CSP,
  PAGE_MAX_HEIGHT,
  PAGE_MIN_HEIGHT,
  PAGE_PREAMBLE,
  PAGE_SANDBOX,
  PAGE_CHANNEL,
  PAGE_STORAGE_MAX_KEY,
  PAGE_STORAGE_MAX_KEYS,
  PAGE_STORAGE_MAX_VALUE_BYTES,
  buildPageDocument,
  cleanPageStorage,
  pageFileName,
  pageThemeCss,
  parsePageFence,
  parsePageMessage,
  DEFAULT_PAGE_THEME,
} from "../src/page.ts";

test("sandbox allows scripts and nothing else", () => {
  assert.equal(PAGE_SANDBOX, "allow-scripts");
  assert.deepEqual(PAGE_SANDBOX.split(/\s+/), ["allow-scripts"]);
});

test("the policy is the first thing in the document and denies the network", () => {
  const doc = buildPageDocument("<p>hi</p>");
  assert.ok(doc.startsWith(PAGE_PREAMBLE));
  assert.ok(doc.startsWith('<!doctype html><meta charset=utf-8><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:;'));
  assert.ok(doc.includes("<meta name=referrer content=no-referrer>"));
  for (const part of ["connect-src 'none'", "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'", "default-src 'none'"]) {
    assert.ok(PAGE_CSP.includes(part), part);
  }
  assert.ok(doc.endsWith("<p>hi</p>"));
});

test("agent content never precedes the policy, even a script before <head>", () => {
  const evil = "<script>window.ran=1</script><html><head><title>x</title></head><body>b</body></html>";
  const doc = buildPageDocument(evil);
  assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf(evil));
  assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf("window.ran"));
  assert.equal(doc.indexOf(evil), doc.length - evil.length);
  const agentDoctype = buildPageDocument("<!doctype html><html><head></head></html>");
  assert.equal(agentDoctype.split("Content-Security-Policy").length, 2);
});

test("empty input still yields a policy-first document", () => {
  const doc = buildPageDocument("");
  assert.ok(doc.startsWith(PAGE_PREAMBLE));
  assert.ok(doc.includes('id="polyth-theme"'));
});

test("theme values cannot break out of the style element", () => {
  const css = pageThemeCss({ ...DEFAULT_PAGE_THEME, accent: "red;}</style><script>x()</script>", font: "" });
  assert.ok(!css.includes("<"));
  assert.ok(css.includes("--polyth-font:" + DEFAULT_PAGE_THEME.font));
  assert.ok(pageThemeCss({ ...DEFAULT_PAGE_THEME, scheme: "light" }).startsWith(":root{color-scheme:light;"));
});

test("fence info: title, from= and the title comment", () => {
  assert.deepEqual(parsePageFence("Checkout mockup\n<p>x</p>"), { title: "Checkout mockup", body: "<p>x</p>" });
  assert.deepEqual(parsePageFence("<p>x</p>"), { title: "", body: "<p>x</p>" });
  assert.equal(parsePageFence("<!-- title: Flow -->\n<p>x</p>").title, "Flow");
  const file = parsePageFence("Big from=_out/page.html");
  assert.equal(file.from, "_out/page.html");
  assert.equal(file.title, "Big");
  for (const bad of ["../x.html", "/etc/x.html", "a/../b.html", "https://x/y.html", "page.js", "a\\b.html"]) {
    const parsed = parsePageFence(`T from=${bad}`);
    assert.equal(parsed.from, undefined, bad);
    assert.equal(parsed.badFrom, bad);
  }
  assert.equal(parsePageFence("").body, "");
});

test("explicit info is authoritative: a plain-text body's first line is body, not title", () => {
  // The host folds `info` in as the first text line and passes `info` too.
  const plain = parsePageFence("Hello world\n<p>x</p>", "");
  assert.equal(plain.title, "");
  assert.equal(plain.body, "Hello world\n<p>x</p>");

  const titled = parsePageFence("Checkout mockup from=ui/a.html\n<p>body</p>", "Checkout mockup from=ui/a.html");
  assert.equal(titled.title, "Checkout mockup");
  assert.equal(titled.from, "ui/a.html");
  assert.equal(titled.body, "<p>body</p>");

  // An empty body: text is exactly the info line.
  const empty = parsePageFence("Just a title", "Just a title");
  assert.equal(empty.title, "Just a title");
  assert.equal(empty.body, "");

  // info non-empty but the fold is absent (a caller passed text without it).
  const noFold = parsePageFence("<p>only</p>", "A title");
  assert.equal(noFold.title, "A title");
  assert.equal(noFold.body, "<p>only</p>");

  // from= validation still applies through info.
  const bad = parsePageFence("T from=../x.html\n<p>b</p>", "T from=../x.html");
  assert.equal(bad.from, undefined);
  assert.equal(bad.badFrom, "../x.html");
});

test("an old host without info keeps the leading-line heuristic", () => {
  // No info argument at all: the pre-existing behaviour is unchanged.
  const plainish = parsePageFence("Hello world\n<p>x</p>");
  assert.equal(plainish.title, "Hello world");
  assert.equal(plainish.body, "<p>x</p>");
  const htmlBody = parsePageFence("<p>x</p>\nsecond");
  assert.equal(htmlBody.title, "");
  assert.equal(htmlBody.body, "<p>x</p>\nsecond");
});

test("messages: channel, kinds, clamping and send limits", () => {
  const c = "polyth-page-v1";
  assert.equal(parsePageMessage({ kind: "height", value: 10 }), null);
  assert.equal(parsePageMessage(null), null);
  assert.deepEqual(parsePageMessage({ channel: c, kind: "height", value: 10 }), { kind: "height", value: PAGE_MIN_HEIGHT });
  assert.deepEqual(parsePageMessage({ channel: c, kind: "height", value: 99999 }), { kind: "height", value: PAGE_MAX_HEIGHT });
  assert.equal(parsePageMessage({ channel: c, kind: "height", value: Number.NaN }), null);
  assert.deepEqual(parsePageMessage({ channel: c, kind: "send", text: "  Pick B  " }), { kind: "send", text: "Pick B" });
  assert.equal(parsePageMessage({ channel: c, kind: "send", text: "   " }), null);
  assert.equal(parsePageMessage({ channel: c, kind: "send", text: "x".repeat(501) }), null);
  assert.equal(parsePageMessage({ channel: c, kind: "send", text: 5 }), null);
  assert.equal(parsePageMessage({ channel: c, kind: "navigate", url: "x" }), null);
});

test("download names are sanitized", () => {
  assert.equal(pageFileName("Checkout mockup"), "Checkout-mockup.html");
  assert.equal(pageFileName("../../etc/passwd"), "etc-passwd.html");
  assert.equal(pageFileName("  "), "page.html");
  assert.equal(pageFileName("Сторінка оплати"), "Сторінка-оплати.html");
});

// ---- polyth.storage --------------------------------------------------------

/** Run the bridge the way a frame would, with a recording parent. */
function runBridge(doc: string) {
  const script = doc.slice(doc.indexOf("<script>") + 8, doc.indexOf("</script>"));
  const posted: Array<Record<string, unknown>> = [];
  const win: { polyth?: { storage: {
    persistent: boolean;
    getItem(key: string): string | null;
    setItem(key: string, value: unknown): void;
    removeItem(key: string): void;
    clear(): void;
    keys(): string[];
  } } } = {};
  const scope = {
    parent: { postMessage: (message: Record<string, unknown>) => { posted.push(message); } },
    document: { documentElement: { getBoundingClientRect: () => ({ height: 10 }) }, getElementById: () => null },
    window: win,
    addEventListener: () => {},
  };
  new Function(...Object.keys(scope), script)(...Object.values(scope));
  return { storage: win.polyth!.storage, changes: () => posted.filter((message) => message.kind === "storage") };
}

test("the storage seed cannot end the bridge script or escape as markup", () => {
  const doc = buildPageDocument("<p>x</p>", DEFAULT_PAGE_THEME, {
    storage: { a: "</script><img src=x onerror=alert(1)>", "line\u2028break": "v", __proto__: "own" } as Record<string, string>,
  });
  assert.equal(doc.split("</script>").length, 2, "one script element: the bridge");
  assert.ok(!doc.slice(0, doc.indexOf("<p>x</p>")).includes("<img"), "the seed is data, not markup");
  const { storage } = runBridge(doc);
  assert.equal(storage.getItem("a"), "</script><img src=x onerror=alert(1)>");
  assert.equal(storage.getItem("line\u2028break"), "v");
  assert.equal(storage.getItem("toString"), null, "only what was stored is there");
  assert.equal(storage.persistent, false);
});

test("a page reads and changes its map like localStorage, and the host hears each change", () => {
  const { storage, changes } = runBridge(buildPageDocument("", DEFAULT_PAGE_THEME, { storage: { a: "1" }, persistent: true }));
  assert.equal(storage.persistent, true);
  assert.deepEqual(storage.keys(), ["a"]);
  storage.setItem("n", 5);
  assert.equal(storage.getItem("n"), "5");
  storage.removeItem("a");
  storage.removeItem("never-set");
  assert.deepEqual(changes(), [
    { kind: "storage", op: "set", key: "n", value: "5", channel: PAGE_CHANNEL },
    { kind: "storage", op: "remove", key: "a", channel: PAGE_CHANNEL },
  ]);
  storage.clear();
  assert.deepEqual(storage.keys(), []);
  assert.throws(() => storage.setItem("", "x"), /invalid key/);
  assert.throws(() => storage.setItem("k".repeat(PAGE_STORAGE_MAX_KEY + 1), "x"), /invalid key/);
  assert.throws(() => storage.setItem("k", "x".repeat(PAGE_STORAGE_MAX_VALUE_BYTES + 1)), /too large/);
  for (let index = 0; index < PAGE_STORAGE_MAX_KEYS; index += 1) storage.setItem(`k${index}`, "v");
  assert.throws(() => storage.setItem("one-more", "v"), /too many keys/);
  storage.setItem("k0", "again");
  assert.equal(storage.getItem("k0"), "again", "an existing key can still change");
});

test("storage messages are validated before a host acts on them", () => {
  const message = (extra: Record<string, unknown>) => parsePageMessage({ channel: PAGE_CHANNEL, kind: "storage", ...extra });
  assert.deepEqual(message({ op: "set", key: "k", value: "v" }), { kind: "storage", op: "set", key: "k", value: "v" });
  assert.deepEqual(message({ op: "remove", key: "k", value: "ignored" }), { kind: "storage", op: "remove", key: "k" });
  assert.deepEqual(message({ op: "clear", key: 5 }), { kind: "storage", op: "clear" });
  assert.equal(message({ op: "set", key: "", value: "v" }), null);
  assert.equal(message({ op: "set", key: "k", value: 5 }), null);
  assert.equal(message({ op: "set", key: "k".repeat(PAGE_STORAGE_MAX_KEY + 1), value: "v" }), null);
  assert.equal(message({ op: "set", key: "k", value: "x".repeat(PAGE_STORAGE_MAX_VALUE_BYTES + 1) }), null);
  assert.equal(message({ op: "set", key: "k", value: "\u00e9".repeat(PAGE_STORAGE_MAX_VALUE_BYTES / 2 + 1) }), null, "the limit is bytes");
  assert.equal(message({ op: "drop", key: "k" }), null);
});

test("a stored map is cleaned before it seeds a page", () => {
  assert.deepEqual({ ...cleanPageStorage({ a: "1", b: 2, c: null, ["k".repeat(PAGE_STORAGE_MAX_KEY + 1)]: "x" }) }, { a: "1" });
  assert.deepEqual({ ...cleanPageStorage(["a"]) }, {});
  assert.deepEqual({ ...cleanPageStorage(null) }, {});
  const many = Object.fromEntries(Array.from({ length: PAGE_STORAGE_MAX_KEYS + 20 }, (_, index) => [`k${index}`, "v"]));
  assert.equal(Object.keys(cleanPageStorage(many)).length, PAGE_STORAGE_MAX_KEYS);
});
