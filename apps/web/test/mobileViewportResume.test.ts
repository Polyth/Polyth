import { test } from "node:test";
import assert from "node:assert/strict";

type ViewportModule = typeof import("../src/mobileViewport.ts");
let sequence = 0;

async function withViewport(run: (env: {
  viewport: EventTarget & { height: number; offsetTop: number; pageTop: number | undefined };
  win: EventTarget & { innerHeight: number; innerWidth: number; visualViewport: unknown; scrollY: number };
  doc: EventTarget & {
    visibilityState: string;
    activeElement: { matches: () => boolean } | null;
    body: { dataset: Record<string, string>; appendChild: (node: unknown) => void };
    documentElement: { clientHeight: number; dataset: Record<string, string>; style: { setProperty: (name: string, value: string) => void } };
    createElement: (tag: string) => { isConnected: boolean; offsetHeight: number; style: { cssText: string }; setAttribute: (name: string, value: string) => void };
  };
  probe: { isConnected: boolean; offsetHeight: number; style: { cssText: string }; setAttribute: (name: string, value: string) => void };
  styles: Map<string, string>;
  api: ViewportModule;
}) => void | Promise<void>) {
  const previous = ["window", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const styles = new Map<string, string>();
  const viewport = Object.assign(new EventTarget(), { height: 440, offsetTop: 0, pageTop: 0 as number | undefined });
  const win = Object.assign(new EventTarget(), { innerHeight: 844, innerWidth: 390, visualViewport: viewport as unknown, scrollY: 0 });
  const probe = {
    isConnected: true,
    offsetHeight: 0,
    style: { cssText: "" },
    setAttribute: () => undefined,
  };
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    activeElement: null as { matches: () => boolean } | null,
    body: { dataset: {} as Record<string, string>, appendChild: () => undefined },
    documentElement: {
      clientHeight: 844,
      dataset: {} as Record<string, string>,
      style: { setProperty: (name: string, value: string) => { styles.set(name, value); } },
    },
    createElement: () => probe,
  });
  Object.defineProperty(globalThis, "window", { value: win, configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true, writable: true });
  try {
    // A fresh module gives each fake page its own measurement singleton.
    const url = new URL("../src/mobileViewport.ts", import.meta.url);
    url.searchParams.set("resume-test", String(++sequence));
    const api = await import(url.href) as ViewportModule;
    await run({ viewport, win, doc, probe, styles, api });
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

test("closed phone and tablet chrome keeps the app at the full layout bottom, not the reduced innerHeight", async () => {
  for (const [layoutHeight, visualHeight] of [[844, 790], [1024, 960]] as const) {
    await withViewport(({ viewport, win, doc, styles, api }) => {
      // iOS WebKit reports the visual band as innerHeight while the layout
      // viewport (`documentElement.clientHeight`, the `100vh` box) stays at the
      // full surface. The closed frame must follow the layout viewport.
      win.innerHeight = visualHeight;
      doc.documentElement.clientHeight = layoutHeight;
      viewport.height = visualHeight;
      viewport.offsetTop = 0;
      api.startMobileViewport();
      assert.equal(doc.body.dataset.keyboard, "closed");
      assert.equal(styles.get("--visual-vh"), `${visualHeight}px`);
      assert.equal(styles.get("--visual-frame-height"), `${layoutHeight}px`);
      assert.equal(styles.get("--visual-bottom"), `${layoutHeight}px`);
      assert.equal(styles.get("--keyboard-inset"), "0px");
    });
  }
});

test("iOS-style reduced innerHeight never leaves a strip below the closed frame", async () => {
  await withViewport(({ viewport, win, doc, styles, api }) => {
    win.innerHeight = 760;
    doc.documentElement.clientHeight = 844;
    viewport.height = 760;
    api.startMobileViewport();
    assert.equal(doc.body.dataset.keyboard, "closed");
    assert.equal(styles.get("--visual-frame-height"), "844px",
      "the frame covers the layout viewport, not the floating-toolbar band");
    assert.equal(styles.get("--visual-vh"), "760px",
      "sheets and pickers still track the reachable visual band");
  });
});

test("a keyboard that shrinks every reported viewport is still detected through the large viewport", async () => {
  await withViewport(({ viewport, win, doc, probe, styles, api }) => {
    // iOS standalone can report innerHeight and clientHeight at the dvh band
    // while 100vh (the probe) stays at the physical screen.
    win.innerHeight = 790;
    doc.documentElement.clientHeight = 790;
    viewport.height = 790;
    probe.offsetHeight = 844;
    api.startMobileViewport();
    assert.equal(doc.body.dataset.keyboard, "closed");
    assert.equal(styles.get("--visual-frame-height"), "790px",
      "the frame itself never grows to the large viewport");

    win.innerHeight = 428;
    doc.documentElement.clientHeight = 428;
    viewport.height = 428;
    viewport.dispatchEvent(new Event("resize"));
    assert.equal(doc.body.dataset.keyboard, "open",
      "the 100vh gap still identifies the keyboard");
    assert.equal(styles.get("--visual-frame-height"), "428px");
    assert.equal(styles.get("--keyboard-inset"), "416px");
  });
});

test("keyboard-covering phone and tablet publishes a bounded visual frame", async () => {
  for (const [layoutHeight, visualHeight, offsetTop, pageTop] of [[844, 440, 0, 220], [1024, 700, 40, 100]] as const) {
    await withViewport(({ viewport, win, styles, doc, api }) => {
      win.innerHeight = layoutHeight;
      viewport.height = visualHeight;
      viewport.offsetTop = offsetTop;
      viewport.pageTop = pageTop;
      api.startMobileViewport();
      assert.equal(doc.body.dataset.keyboard, "open");
      assert.equal(styles.get("--visual-frame-top"), `${offsetTop}px`);
      assert.equal(styles.get("--visual-frame-height"), `${visualHeight}px`);
      assert.equal(styles.get("--visual-bottom"), `${offsetTop + visualHeight}px`);
      assert.equal(styles.get("--keyboard-inset"), `${layoutHeight - visualHeight - offsetTop}px`);
    });
  }
});

test("document pan/pageTop never grows the visual frame", async () => {
  await withViewport(({ viewport, win, styles, api }) => {
    viewport.height = 440;
    viewport.offsetTop = 0;
    viewport.pageTop = 220;
    api.startMobileViewport();
    assert.equal(styles.get("--visual-frame-top"), "0px");
    assert.equal(styles.get("--visual-frame-height"), "440px");
    assert.equal(styles.get("--visual-bottom"), "440px");

    viewport.pageTop = 300;
    win.scrollY = 300;
    viewport.dispatchEvent(new Event("scroll"));
    assert.equal(styles.get("--visual-frame-height"), "440px");
    assert.equal(styles.get("--visual-bottom"), "440px");
  });
});

test("offsetTop is a separate frame position, never a document-coordinate height", async () => {
  await withViewport(({ viewport, win, styles, api }) => {
    viewport.height = 700;
    viewport.offsetTop = 40;
    viewport.pageTop = 100;
    win.innerHeight = 1024;
    api.startMobileViewport();
    assert.equal(styles.get("--visual-frame-top"), "40px");
    assert.equal(styles.get("--visual-frame-height"), "700px");
    assert.equal(styles.get("--visual-bottom"), "740px", "offsetTop + visual height");

    viewport.pageTop = undefined;
    win.scrollY = 120;
    viewport.dispatchEvent(new Event("scroll"));
    assert.equal(styles.get("--visual-bottom"), "740px", "document scroll does not change frame geometry");
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

// iOS can report the full-height viewport of a closing keyboard while the pan
// that revealed the composer is still at its old offset, and only then the pan
// back to 0. Every sheet and dialog is `top: var(--visual-offset)`, so an
// offset left over from that first event held them a keyboard height down
// the screen until the next keyboard.
test("a keyboard that closes before its pan returns leaves no offset behind", async () => {
  await withViewport(({ viewport, doc, styles, api }) => {
    viewport.height = 484;
    viewport.offsetTop = 345;
    doc.activeElement = { matches: () => true };
    api.startMobileViewport();
    assert.equal(doc.body.dataset.keyboard, "open");
    assert.equal(styles.get("--visual-offset"), "345px");

    doc.activeElement = null;
    viewport.height = 844;
    viewport.dispatchEvent(new Event("resize"));
    assert.equal(doc.body.dataset.keyboard, "closed");
    assert.equal(styles.get("--visual-offset"), "0px", "a closed frame starts at the layout top");

    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("scroll"));
    assert.equal(styles.get("--visual-offset"), "0px");
    assert.equal(styles.get("--visual-frame-top"), "0px");
  });
});

test("every published frame variable follows a change that leaves the frame edges in place", async () => {
  await withViewport(({ viewport, win, doc, styles, api }) => {
    win.innerHeight = 844;
    doc.documentElement.clientHeight = 844;
    viewport.height = 844;
    api.startMobileViewport();
    assert.equal(styles.get("--visual-vh"), "844px");

    // Closed: the frame is the layout viewport either way, but sheets size
    // themselves by the reachable visual band.
    viewport.height = 790;
    viewport.dispatchEvent(new Event("resize"));
    assert.equal(doc.body.dataset.keyboard, "closed");
    assert.equal(styles.get("--visual-frame-height"), "844px");
    assert.equal(styles.get("--visual-vh"), "790px");
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

test("closed frame republishes when the layout viewport height changes with identical visual metrics", async () => {
  await withViewport(({ viewport, win, doc, styles, api }) => {
    viewport.height = 790;
    win.innerHeight = 790;
    doc.documentElement.clientHeight = 844;
    api.startMobileViewport();
    assert.equal(api.getViewportMetrics().covering, false);
    assert.equal(styles.get("--visual-bottom"), "844px");

    // Both states remain below the keyboard threshold, so ViewportMetrics is
    // unchanged; the published frame must still follow the new layout bottom.
    doc.documentElement.clientHeight = 800;
    win.dispatchEvent(new Event("pageshow"));
    assert.equal(api.getViewportMetrics().covering, false);
    assert.equal(styles.get("--visual-bottom"), "800px");
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

test("the keyboard source is native only while the native plugin supplies the inset", async () => {
  // The Capacitor shell resizes its WebView to end at the keyboard and hides
  // WebKit's form accessory; mobileViewport.css zeroes the accessory band on
  // this marker. A Safari keyboard measured from visualViewport stays "viewport".
  await withViewport(({ viewport, win, doc, api }) => {
    win.innerHeight = 844;
    viewport.height = 844;
    api.startMobileViewport();
    assert.equal(doc.body.dataset.keyboardSource, "viewport");

    // Native resize: the WebView (and with it every reported viewport) already
    // ends at the keyboard, so only the plugin's inset reveals it.
    win.innerHeight = 504;
    viewport.height = 504;
    doc.documentElement.clientHeight = 504;
    api.setNativeKeyboardInset(340);
    assert.equal(doc.body.dataset.keyboard, "open");
    assert.equal(doc.body.dataset.keyboardSource, "native");

    api.setNativeKeyboardInset(0);
    assert.equal(doc.body.dataset.keyboardSource, "viewport");

    // A Safari keyboard (visual band shrinks inside a tall layout) is not native.
    win.innerHeight = 844;
    doc.documentElement.clientHeight = 844;
    viewport.height = 440;
    viewport.dispatchEvent(new Event("resize"));
    assert.equal(doc.body.dataset.keyboard, "open");
    assert.equal(doc.body.dataset.keyboardSource, "viewport");
  });
});

/** The iOS app (KeyboardResize.Native) at rest: every reported viewport is the
 *  full WebView, which the plugin shrinks only after the keyboard has slid. */
function nativeAppAtRest(env: { win: { innerHeight: number }; viewport: { height: number }; doc: { documentElement: { clientHeight: number } } }, height = 844) {
  env.win.innerHeight = height;
  env.viewport.height = height;
  env.doc.documentElement.clientHeight = height;
}

test("an iOS keyboard moves the frame from the plugin event, not after the deferred WebView resize", async () => {
  await withViewport(async (env) => {
    const { viewport, win, doc, styles, api } = env;
    nativeAppAtRest(env);
    api.startMobileViewport();
    assert.equal(styles.get("--visual-frame-bottom"), "844px");

    // keyboardWillShow: the keyboard starts to slide, the WebView is still 844.
    api.setNativeKeyboardInset(336, { followKeyboard: true });
    assert.equal(styles.get("--visual-frame-bottom"), "508px", "the frame takes the keyboard's final edge at once");
    assert.equal(styles.get("--visual-frame-height"), "508px");
    assert.equal(styles.get("--visual-vh"), "508px");
    assert.equal(styles.get("--keyboard-inset"), "336px");
    assert.equal(doc.body.dataset.keyboard, "open");
    assert.equal(doc.body.dataset.keyboardSource, "native");
    assert.equal(doc.documentElement.dataset.keyboardFrame, "open");
    // Nothing transitions: no motion marker restyles <html> mid-slide.
    assert.equal(doc.documentElement.dataset.keyboardMotion, undefined);

    // The plugin's WebView resize lands after the slide (+0.2 s): no jump.
    nativeAppAtRest(env, 508);
    win.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("resize"));
    assert.equal(styles.get("--visual-frame-bottom"), "508px");

    // keyboardWillHide: the frame is the closed layout at once, while the
    // plugin still has the WebView at the keyboard's size for a moment.
    api.setNativeKeyboardInset(0, { followKeyboard: true });
    assert.equal(doc.body.dataset.keyboard, "closed");
    assert.equal(doc.documentElement.dataset.keyboardFrame, "closed");
    assert.equal(styles.get("--visual-frame-bottom"), "844px", "the closed frame is projected before the WebView grows");
    assert.equal(styles.get("--visual-vh"), "844px");
    nativeAppAtRest(env, 844);
    win.dispatchEvent(new Event("resize"));
    assert.equal(styles.get("--visual-frame-bottom"), "844px");

    // A later keyboard is projected from the restored closed size, not from
    // a measurement taken while the WebView was still short.
    api.setNativeKeyboardInset(300, { followKeyboard: true });
    assert.equal(styles.get("--visual-frame-bottom"), "544px");
  });
});

test("a focused editor does not hold a projected native keyboard frame", async () => {
  await withViewport((env) => {
    const { doc, styles, api } = env;
    nativeAppAtRest(env);
    api.startMobileViewport();
    // The composer took focus in the same gesture that raised the keyboard.
    doc.activeElement = { matches: () => true };
    api.setNativeKeyboardInset(336, { followKeyboard: true });
    assert.equal(styles.get("--visual-frame-bottom"), "508px", "no two-frame settle wait for a known geometry");
  });
});

test("only a shell that defers its resize gets a projected frame", async () => {
  await withViewport((env) => {
    const { styles, api } = env;
    nativeAppAtRest(env);
    api.startMobileViewport();
    // Android: the WebView follows the insets itself; keep measuring.
    api.setNativeKeyboardInset(336);
    assert.equal(styles.get("--visual-frame-bottom"), "844px");
    api.setNativeKeyboardInset(0);
    assert.equal(styles.get("--visual-frame-bottom"), "844px");
  });
});

test("the shared layer edge carries no accessory band outside WebKit or in the native shell", async () => {
  await withViewport((env) => {
    const { styles, api } = env;
    nativeAppAtRest(env);
    api.startMobileViewport();
    assert.equal(styles.get("--layer-frame-bottom"), "844px");
    api.setNativeKeyboardInset(336, { followKeyboard: true });
    assert.equal(styles.get("--layer-frame-bottom"), "508px", "the native keyboard frame is the layer edge");
  });
});

test("the WebKit accessory band joins the layer edge of an open Safari frame only", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  Object.defineProperty(globalThis, "CSS", {
    value: { supports: (property: string, value: string) => property === "-webkit-touch-callout" && value === "none" },
    configurable: true,
    writable: true,
  });
  try {
    await withViewport((env) => {
      const { viewport, win, doc, styles, api } = env;
      Object.assign(win, { matchMedia: (query: string) => ({ matches: query.includes("max-width: 1024px") }) });
      Object.assign(doc.body, { classList: { contains: () => false } });
      Object.assign(globalThis, { getComputedStyle: () => ({ getPropertyValue: (name: string) => name === "--keyboard-accessory-band" ? "48px" : "" }) });
      // Safari: the keyboard covers the layout from the visual viewport.
      win.innerHeight = 844;
      doc.documentElement.clientHeight = 844;
      viewport.height = 440;
      api.startMobileViewport();
      assert.equal(doc.body.dataset.keyboard, "open");
      assert.equal(styles.get("--visual-frame-bottom"), "440px");
      assert.equal(styles.get("--layer-frame-bottom"), "488px", "measured edge plus the accessory band");
      viewport.height = 844;
      viewport.dispatchEvent(new Event("resize"));
      assert.equal(styles.get("--layer-frame-bottom"), "844px", "a closed frame has no band");
      // The native shell hides the accessory: never a band there.
      api.setNativeKeyboardInset(336, { followKeyboard: true });
      assert.equal(styles.get("--layer-frame-bottom"), "508px");
    });
  } finally {
    Reflect.deleteProperty(globalThis, "getComputedStyle");
    if (previous) Object.defineProperty(globalThis, "CSS", previous);
    else Reflect.deleteProperty(globalThis, "CSS");
  }
});

test("a projection never applies across an orientation change or once the WebView has resized", async () => {
  await withViewport((env) => {
    const { win, styles, api } = env;
    nativeAppAtRest(env);
    api.startMobileViewport();
    // Rotated with the keyboard coming up: the closed size belongs to the old width.
    win.innerWidth = 844;
    api.setNativeKeyboardInset(200, { followKeyboard: true });
    assert.equal(styles.get("--visual-frame-bottom"), "844px");
    api.setNativeKeyboardInset(0, { followKeyboard: true });

    // Already resized for a previous keyboard: the measurement is the truth.
    win.innerWidth = 390;
    nativeAppAtRest(env, 844);
    win.dispatchEvent(new Event("resize"));
    nativeAppAtRest(env, 508);
    api.setNativeKeyboardInset(336, { followKeyboard: true });
    assert.equal(styles.get("--visual-frame-bottom"), "508px");
  });
});

test("reduced motion still moves the frame with the keyboard but never marks a transition", async () => {
  await withViewport((env) => {
    const { doc, styles, api } = env;
    doc.documentElement.dataset.reduceAnimations = "true";
    nativeAppAtRest(env);
    api.startMobileViewport();
    api.setNativeKeyboardInset(336, { followKeyboard: true });
    assert.equal(styles.get("--visual-frame-bottom"), "508px");
    assert.equal(doc.documentElement.dataset.keyboardMotion, undefined);
  });
});

// "Periodic jump": Safari can dispatch the keyboard resize and
// the pan that reveals a focused composer as two separate visualViewport
// events. A frame published from the resize alone undershoots the panned
// bottom edge (offsetTop still 0) and exposes the canvas below the composer
// for a frame or two, above the keyboard's real position.
test("a keyboard-open resize with a focused composer holds the shrink until the paired pan offset arrives", async () => {
  await withViewport(async ({ viewport, win, doc, styles, api }) => {
    win.innerHeight = 844;
    viewport.height = 844;
    viewport.offsetTop = 0;
    api.startMobileViewport();
    assert.equal(styles.get("--visual-bottom"), "844px", "starts closed at the full layout height");

    doc.activeElement = { matches: () => true };
    viewport.height = 440;
    viewport.dispatchEvent(new Event("resize"));
    assert.equal(styles.get("--visual-bottom"), "844px",
      "the resize-only shrink is held: offsetTop has not confirmed the pan yet");

    viewport.offsetTop = 220;
    viewport.dispatchEvent(new Event("scroll"));
    assert.equal(styles.get("--visual-bottom"), "844px",
      "still held: the settle window opened by the resize has not elapsed");

    await new Promise((resolve) => { setTimeout(resolve, 100); });
    assert.equal(styles.get("--visual-bottom"), "660px",
      "settles to offsetTop + height once both signals are in, never having painted the undershot 440px frame");
  });
});

test("a held shrink still applies once no paired pan offset ever arrives", async () => {
  await withViewport(async ({ viewport, win, doc, styles, api }) => {
    win.innerHeight = 844;
    viewport.height = 844;
    viewport.offsetTop = 0;
    api.startMobileViewport();

    doc.activeElement = { matches: () => true };
    viewport.height = 440;
    viewport.dispatchEvent(new Event("resize"));
    assert.equal(styles.get("--visual-bottom"), "844px", "held pending the settle window");

    await new Promise((resolve) => { setTimeout(resolve, 100); });
    assert.equal(styles.get("--visual-bottom"), "440px",
      "no pan ever came (e.g. no focused input, or an engine that only resizes), so the shrink applies once settled");
  });
});

// Safari reveals a focused field by panning inside the tall layout viewport;
// the layers then shrink to that band and can leave the field below the bottom
// of its scroll container. These fakes carry just the DOM surface
// mobileFieldReveal.ts reads: a vertical scroller holding one text field.
function scrollerWithField(fieldBox = { top: 500, bottom: 540, height: 40 }) {
  let styleReads = 0;
  const scroller = {
    parentElement: null as unknown,
    scrollHeight: 1000,
    clientHeight: 300,
    clientTop: 0,
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 100, bottom: 400, height: 300 }),
  };
  const field = {
    matches: () => true,
    parentElement: scroller,
    ownerDocument: {
      body: {},
      defaultView: { getComputedStyle: () => { styleReads += 1; return { overflowY: "auto" }; } },
    },
    getBoundingClientRect: () => fieldBox,
  };
  return { scroller, field, styleReads: () => styleReads };
}

test("a keyboard-covering frame change brings the focused field back into its scroller, once, a frame later", async () => {
  await withViewport(async ({ viewport, doc, api }) => {
    const { scroller, field, styleReads } = scrollerWithField();
    doc.activeElement = field;
    viewport.height = 440;
    api.startMobileViewport();
    assert.equal(doc.body.dataset.keyboard, "open");
    assert.equal(scroller.scrollTop, 0, "layout has not applied the new frame yet, so nothing is measured now");

    // A pan animation delivers a burst of offset updates; one pass covers them.
    viewport.offsetTop = 40;
    viewport.dispatchEvent(new Event("scroll"));
    viewport.offsetTop = 80;
    viewport.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    // Field bottom 540 sits 148px below the scroller's bottom edge less the 8px margin.
    assert.equal(scroller.scrollTop, 148);
    assert.equal(styleReads(), 1, "the burst is coalesced into one reveal pass");
  });
});

test("the field is only revealed while a keyboard covers the layout and a text entry has focus", async () => {
  await withViewport(async ({ viewport, win, doc, api }) => {
    // Keyboard closed with a field focused: the frame is the layout viewport.
    const closed = scrollerWithField();
    win.innerHeight = 844;
    viewport.height = 844;
    doc.activeElement = closed.field;
    api.startMobileViewport();
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    assert.equal(closed.scroller.scrollTop, 0, "no keyboard, nothing to reveal");

    // Keyboard open but focus on something that is not a text entry.
    const idle = scrollerWithField();
    idle.field.matches = () => false;
    doc.activeElement = idle.field;
    viewport.height = 440;
    viewport.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    assert.equal(idle.scroller.scrollTop, 0, "a non-text focus is never scrolled into view");
  });
});

test("an unchanged measurement does not reveal again, so the user's own scrolling is left alone", async () => {
  await withViewport(async ({ viewport, doc, api }) => {
    const { scroller, field } = scrollerWithField();
    doc.activeElement = field;
    viewport.height = 440;
    api.startMobileViewport();
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    assert.equal(scroller.scrollTop, 148);

    scroller.scrollTop = 0; // the user scrolls the field away on purpose
    viewport.dispatchEvent(new Event("resize"));
    doc.dispatchEvent(new Event("focusin"));
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    assert.equal(scroller.scrollTop, 0, "identical geometry publishes nothing, so nothing is pulled back");
  });
});
