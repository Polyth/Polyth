// The launch veil index.html paints first, and the driver that
// lifts it. Uses the real markup and activation script from index.html.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const html = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const veilMarkup = html.match(/<div id="polyth-launch"[\s\S]*?<\/div>/)?.[0] ?? "";
const activation = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1]!)
  .find((script) => script.includes("polyth-launch")) ?? "";

let reducedMotion = false;
const dom = new Window({ url: "http://localhost:3000/" });
const matchMedia = (query: string) => ({
  matches: query.includes("reduced-motion") ? reducedMotion : false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
});
Object.defineProperty(dom, "matchMedia", { configurable: true, value: matchMedia });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  getComputedStyle: (element: Element) =>
    (dom as unknown as { getComputedStyle(el: Element): CSSStyleDeclaration }).getComputedStyle(element),
});
Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });

const { launchVeil } = await import("../src/launchVeil.ts");

function mountVeil(): HTMLElement {
  document.documentElement.setAttribute("data-launch", "veiled");
  document.body.innerHTML = `${veilMarkup}<div id="root"></div>`;
  return document.getElementById("polyth-launch")!;
}

test("index.html paints the veil before any script and drops it only on desktop", () => {
  assert.ok(veilMarkup, "veil markup present");
  assert.doesNotMatch(veilMarkup, /\shidden[\s>]/, "visible by default: no frame can paint without it");
  assert.match(html, /<html lang="en" data-launch="veiled">/);
  assert.ok(activation, "activation script present");
  const runActivation = (env: { native?: boolean; coarse?: boolean; narrow?: boolean }) => {
    mountVeil();
    const windowLike = {
      Capacitor: env.native ? { isNativePlatform: () => true } : undefined,
    };
    const media = (query: string) => ({
      matches: query.includes("coarse") ? !!env.coarse : query.includes("max-width") ? !!env.narrow : false,
    });
    new Function("window", "document", "matchMedia", "setTimeout", activation)(
      windowLike, document, media, () => 0,
    );
    return {
      veil: document.getElementById("polyth-launch"),
      launch: document.documentElement.getAttribute("data-launch"),
    };
  };
  const desktop = runActivation({});
  assert.equal(desktop.veil, null);
  assert.equal(desktop.launch, null);
  for (const env of [{ coarse: true }, { narrow: true }, { native: true }]) {
    const phone = runActivation(env);
    assert.ok(phone.veil, JSON.stringify(env));
    assert.equal(phone.launch, "veiled");
  }
});

test("a long wait breathes and shows one status line; reduced motion keeps it still", () => {
  const veil = mountVeil();
  assert.equal(launchVeil.active, true);
  launchVeil.wait("Opening your workspace…");
  assert.equal(veil.dataset.state, "waiting");
  assert.equal(veil.dataset.status, "shown");
  assert.equal(veil.querySelector(".polyth-launch-status")?.textContent, "Opening your workspace…");
  launchVeil.setStatus(null);
  assert.equal(veil.dataset.status, undefined);

  reducedMotion = true;
  try {
    const still = mountVeil();
    launchVeil.wait("Connecting…");
    assert.equal(still.dataset.state, undefined);
    assert.equal(still.dataset.status, "shown");
  } finally {
    reducedMotion = false;
  }
});

test("lifting clears the veil once and restore brings it back", async () => {
  const veil = mountVeil();
  const first = launchVeil.lift();
  assert.equal(launchVeil.lift(), first, "a second lift joins the first");
  await first;
  assert.equal(veil.hidden, true);
  assert.equal(document.documentElement.hasAttribute("data-launch"), false);
  assert.equal(launchVeil.active, false);

  await launchVeil.restore();
  assert.equal(veil.hidden, false);
  assert.equal(document.documentElement.getAttribute("data-launch"), "veiled");
  assert.equal(launchVeil.active, true);
  await launchVeil.lift();
  assert.equal(veil.hidden, true);
});

test("the mark flies onto the hub's brand mark and that mark only shows once it landed", async () => {
  const veil = mountVeil();
  await launchVeil.restore();
  const brand = document.createElement("img");
  document.body.append(brand);
  // happy-dom has no layout: give the veil mark and the brand mark real boxes.
  const veilMark = veil.querySelector(".polyth-launch-mark")!;
  for (const [key, value] of Object.entries({ offsetLeft: 110, offsetTop: 337, offsetWidth: 170 })) {
    Object.defineProperty(veilMark, key, { configurable: true, value });
  }
  brand.getBoundingClientRect = () => ({ left: 12, top: 30, width: 56, height: 56, right: 68, bottom: 86, x: 12, y: 30, toJSON: () => ({}) }) as DOMRect;
  const played: Array<{ element: Element; keyframes: Keyframe[] }> = [];
  const proto = (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement.prototype as HTMLElement & {
    animate?: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => Animation;
  };
  const original = proto.animate;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  proto.animate = function animate(this: Element, keyframes: Keyframe[]) {
    played.push({ element: this, keyframes });
    return { finished: done.then(() => this as unknown as Animation), cancel: () => {} } as unknown as Animation;
  };
  try {
    const lifted = launchVeil.lift({ into: brand });
    assert.equal(brand.style.visibility, "hidden", "one mark on screen during the flight");
    const mark = veil.querySelector(".polyth-launch-mark");
    const flight = played.find((entry) => entry.element === mark);
    assert.ok(flight, "the mark animates");
    assert.match(String(flight!.keyframes.at(-1)?.transform), /translate3d\(.*\) scale\(/);
    assert.ok(played.some((entry) => entry.element === veil && "backgroundColor" in (entry.keyframes[0] ?? {})),
      "the night dissolves behind the mark");
    finish();
    await lifted;
    assert.equal(brand.style.visibility, "");
    assert.equal(veil.hidden, true);
  } finally {
    proto.animate = original;
  }
});
