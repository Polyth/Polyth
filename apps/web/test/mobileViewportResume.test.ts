import { test } from "node:test";
import assert from "node:assert/strict";

type ViewportModule = typeof import("../src/mobileViewport.ts");
let sequence = 0;

async function withViewport(run: (env: {
  viewport: EventTarget & { height: number; offsetTop: number };
  win: EventTarget & { innerHeight: number; visualViewport: unknown };
  doc: EventTarget & { visibilityState: string; activeElement: { matches: () => boolean } | null; body: { dataset: Record<string, string> } };
  styles: Map<string, string>;
  api: ViewportModule;
}) => void | Promise<void>) {
  const previous = ["window", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const styles = new Map<string, string>();
  const viewport = Object.assign(new EventTarget(), { height: 440, offsetTop: 0 });
  const win = Object.assign(new EventTarget(), { innerHeight: 844, visualViewport: viewport as unknown });
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    activeElement: null as { matches: () => boolean } | null,
    body: { dataset: {} as Record<string, string> },
    documentElement: { style: { setProperty: (name: string, value: string) => { styles.set(name, value); } } },
  });
  Object.defineProperty(globalThis, "window", { value: win, configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true, writable: true });
  try {
    // A fresh module gives each fake page its own measurement singleton.
    const url = new URL("../src/mobileViewport.ts", import.meta.url);
    url.searchParams.set("resume-test", String(++sequence));
    const api = await import(url.href) as ViewportModule;
    await run({ viewport, win, doc, styles, api });
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("pageshow remeasures a restored page without waiting for resize", async () => {
  await withViewport(({ viewport, win, doc, styles, api }) => {
    api.startMobileViewport();
    assert.equal(doc.body.dataset.keyboard, "open");
    viewport.height = 844;
    win.dispatchEvent(new Event("pageshow"));
    assert.equal(styles.get("--visual-bottom"), "844px");
    assert.equal(styles.get("--keyboard-inset"), "0px");
    assert.equal(doc.body.dataset.keyboard, "closed");
  });
});

test("visible resume refreshes the frame but hidden transitions do not publish transient geometry", async () => {
  await withViewport(({ viewport, doc, styles, api }) => {
    api.startMobileViewport();
    doc.visibilityState = "hidden";
    viewport.height = 0;
    doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(styles.get("--visual-bottom"), "440px");
    viewport.height = 844;
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(styles.get("--visual-bottom"), "844px");
    assert.equal(doc.body.dataset.keyboard, "closed");
  });
});

test("resume clears a stale Safari pan offset as well as keyboard height", async () => {
  await withViewport(({ viewport, win, doc, styles, api }) => {
    viewport.height = 484;
    viewport.offsetTop = 360;
    doc.activeElement = { matches: () => true };
    api.startMobileViewport();
    assert.equal(doc.body.dataset.keyboard, "open");
    assert.equal(styles.get("--visual-offset"), "360px");
    viewport.height = 844;
    viewport.offsetTop = 0;
    doc.activeElement = null;
    win.dispatchEvent(new Event("pageshow"));
    assert.equal(styles.get("--visual-offset"), "0px");
    assert.equal(doc.body.dataset.keyboard, "closed");
    assert.equal(api.getViewportMetrics().covering, false);
  });
});

test("resume uses layout geometry when visualViewport is unavailable", async () => {
  await withViewport(({ win, styles, api }) => {
    win.visualViewport = undefined;
    win.innerHeight = 440;
    api.startMobileViewport();
    win.innerHeight = 844;
    win.dispatchEvent(new Event("pageshow"));
    assert.equal(styles.get("--visual-vh"), "844px");
  });
});

test("startup remains idempotent and repeated resume events do not notify unchanged measurements", async () => {
  await withViewport(({ viewport, win, doc, api }) => {
    api.startMobileViewport();
    api.startMobileViewport();
    let changes = 0;
    const unsubscribe = api.subscribeViewport(() => { changes += 1; });
    viewport.height = 844;
    win.dispatchEvent(new Event("pageshow"));
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("pageshow"));
    assert.equal(changes, 1);
    unsubscribe();
  });
});

test("ordinary viewport resize and native keyboard updates retain their existing behavior", async () => {
  await withViewport(({ viewport, styles, doc, api }) => {
    api.startMobileViewport();
    viewport.height = 844;
    viewport.dispatchEvent(new Event("resize"));
    assert.equal(styles.get("--visual-bottom"), "844px");
    api.setNativeKeyboardInset(300);
    assert.equal(styles.get("--keyboard-inset"), "300px");
    assert.equal(doc.body.dataset.keyboard, "open");
    api.setNativeKeyboardInset(0);
    assert.equal(doc.body.dataset.keyboard, "closed");
  });
});
