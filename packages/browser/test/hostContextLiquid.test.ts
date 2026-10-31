import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { act, createElement, type ReactNode } from "react";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import type { Browser } from "playwright-core";
import { findChromiumExecutable } from "@polyth/browser/chromium";
import { browserBuildOptions, uiFontScalePlugin } from "../../../apps/web/buildConfig.ts";
import { setLocale } from "../../../apps/web/src/i18n/index.ts";
import { emptyModel } from "../../../apps/web/src/reduce.ts";
import type { ContextGauge } from "../../../apps/web/src/reduce.ts";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { default: ContextLiquid, contextLiquidLabel } = await import("../../../apps/web/src/components/ContextLiquid.tsx");
const { default: SessionActivityDetails } = await import("../../../apps/web/src/components/SessionActivityDetails.tsx");
const { Icon } = await import("../../../apps/web/src/icons.tsx");
const { ChevronDownIcon, QueueSendIcon } = await import("../../../apps/web/src/components/ui/icons.ts");

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
const markup = (node: ReactNode) => renderToStaticMarkup(createElement("div", null, node)).slice(5, -6);
const CHROME = await findChromiumExecutable();

function gauge(percent: number | null, quality: "native" | "estimated" | "fraction" = "native"): ContextGauge {
  if (percent === null) {
    return { known: false, inputTokens: 0, contextTokens: null, percent: null, level: "unknown", quality: "unknown" };
  }
  if (quality === "fraction") {
    return { known: false, inputTokens: 0, contextTokens: null, percent, level: "fraction", quality: "fraction" };
  }
  return {
    known: true,
    inputTokens: percent * 1_000,
    contextTokens: 100_000,
    percent,
    level: percent < 70 ? "green" : percent < 90 ? "yellow" : "red",
    quality,
  };
}

const liquid = (value: ContextGauge, glyph: ReactNode) => markup(createElement(ContextLiquid, { gauge: value, children: glyph }));

test("the liquid carries the fill level and repeats the host glyph below the waterline", () => {
  const html = liquid(gauge(42), createElement(Icon.stop));
  assert.match(html, /^<span class="context-liquid" style="--context-fill:42%" aria-hidden="true">/);
  assert.match(html, /<span class="context-liquid-wave context-liquid-back"><\/span>/);
  assert.match(
    html,
    /<span class="context-liquid-wave context-liquid-front"><svg[^>]*><rect[^>]*><\/rect><\/svg><\/span><\/span>$/,
    "the front wave holds the glyph copy the ink color is applied to",
  );
  assert.match(liquid(gauge(0), createElement(Icon.stop)), /--context-fill:0%/, "an empty context keeps the liquid mounted so the first sample pours in");
  assert.match(liquid(gauge(30, "fraction"), createElement(Icon.stop)), /--context-fill:30%/, "a runtime fraction still fills");
  assert.equal(liquid(gauge(null), createElement(Icon.stop)), "", "unknown usage leaves the plain outline");
});

test("the action tooltip names the context level only when it is known", () => {
  assert.equal(contextLiquidLabel(gauge(42)), "Context 42%");
  assert.equal(contextLiquidLabel(gauge(42, "estimated")), "Context ~42%");
  assert.equal(contextLiquidLabel(gauge(null)), null);
});

test("the activity details render a localized context sample", async () => {
  await setLocale("uk");
  try {
    const sample: ContextGauge = {
      known: false,
      inputTokens: 11_500_000,
      contextTokens: null,
      percent: null,
      level: "unknown",
      quality: "estimated",
    };
    const dom = new Window({ url: "http://127.0.0.1:4400/" });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousHTMLElement = globalThis.HTMLElement;
    const previousElement = globalThis.Element;
    const previousNode = globalThis.Node;
    const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    Object.assign(globalThis, {
      window: dom,
      document: dom.document,
      HTMLElement: dom.HTMLElement,
      Element: dom.Element,
      Node: dom.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as HTMLElement);
    try {
      await act(async () => root.render(createElement(SessionActivityDetails, {
        sessionTitle: "Довгий тестовий сеанс",
        showIdentity: false,
        tasks: [],
        session: null,
        model: emptyModel(),
        gauge: sample,
      })));
      assert.match(container.innerHTML, /session-activity-context-card/);
      assert.match(container.innerHTML, /Зафіксовано ~11,5M токенів; ліміт вікна недоступний/);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await dom.happyDOM.close();
      if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else Object.assign(globalThis, { window: previousWindow });
      if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.assign(globalThis, { document: previousDocument });
      if (previousHTMLElement === undefined) delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
      else Object.assign(globalThis, { HTMLElement: previousHTMLElement });
      if (previousElement === undefined) delete (globalThis as { Element?: unknown }).Element;
      else Object.assign(globalThis, { Element: previousElement });
      if (previousNode === undefined) delete (globalThis as { Node?: unknown }).Node;
      else Object.assign(globalThis, { Node: previousNode });
      if (previousActEnvironment === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
      else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  } finally {
    await setLocale("en");
  }
});

test("both running primaries are the context gauge; idle Send is not", async () => {
  const composer = await read("../../../apps/web/src/components/Composer.tsx");
  assert.match(composer, /const contextGauge = useActiveContextGauge\(model\);/);
  const running = composer.slice(composer.indexOf("{canStop ? ("), composer.indexOf('<button className="send" onPointerDown={onPrimaryPointerDown}'));
  assert.match(
    running,
    /className=\{`send composer-delivery\$\{queueEdit \? "" : " composer-running-send"\} context-liquid-host`\}[\s\S]*?\{runningPrimaryGlyph\}[\s\S]*?<ContextLiquid key=\{session\?\.id\} gauge=\{contextGauge\}>\{runningPrimaryGlyph\}<\/ContextLiquid>/,
    "Send now / queued save fills behind the same glyph",
  );
  assert.match(
    running,
    /className="stop composer-stop-primary context-liquid-host"[\s\S]*?<Icon\.stop \/>[\s\S]*?<ContextLiquid key=\{session\?\.id\} gauge=\{contextGauge\}><Icon\.stop \/><\/ContextLiquid>/,
    "Stop fills behind its own glyph",
  );
  assert.match(running, /title=\{withContextLabel\(tr\("composer\.stopTheCurrentResponse"\)\)\}/);
  assert.match(running, /title=\{withContextLabel\(runningPrimaryTitle\)\}/);
  const idle = composer.slice(composer.indexOf('<button className="send" onPointerDown={onPrimaryPointerDown}'));
  assert.doesNotMatch(idle.slice(0, idle.indexOf("</button>")), /context-liquid/, "the idle Send keeps its solid call to action");
});

test("session titles carry no provider logo or context donut", async () => {
  const [desktop, mobile, pages, prefs, styles] = await Promise.all([
    read("../../../apps/web/src/components/DesktopSessionStatus.tsx"),
    read("../../../apps/web/src/components/mobile/MobileSessionHeader.tsx"),
    read("../../../apps/web/src/components/settings/pages.tsx"),
    read("../../../apps/web/src/uiPrefs.ts"),
    read("../../../apps/web/src/styles.css"),
  ]);
  for (const header of [desktop, mobile]) assert.doesNotMatch(header, /ContextIndicator|ProviderLogo/);
  assert.doesNotMatch(pages, /appearance\.contextIndicator|Donut|mobileSessionTitleWithLogo/);
  assert.doesNotMatch(prefs, /contextIndicatorMode/);
  assert.doesNotMatch(styles, /\.context-indicator/);
});

test("the liquid follows the action's solid colors and leaves motion to the global rules", async () => {
  const [styles, adaptive] = await Promise.all([read("../../../apps/web/src/styles.css"), read("../../../apps/web/src/composerAdaptive.css")]);
  assert.match(styles, /\.composer-simple \.composer-rail \.send \{[^}]*background: var\(--composer-green\);[^}]*--context-liquid-tone: var\(--composer-green\);[^}]*--context-liquid-ink: var\(--accent-ink\);/s);
  assert.match(styles, /\.composer-rail \.composer-stop-primary \{[^}]*color: var\(--red\);[^}]*--context-liquid-tone: var\(--red\);[^}]*--context-liquid-ink: var\(--red-ink\);/s);
  assert.match(styles, /\.composer-mobile \.composer-rail \.stop \{[^}]*background: var\(--text\);[^}]*--context-liquid-tone: var\(--text\);[^}]*--context-liquid-ink: var\(--bg\);/s);
  assert.match(adaptive, /@property --context-fill \{\s*syntax: "<percentage>";\s*inherits: true;\s*initial-value: 0%;\s*\}/);
  assert.match(adaptive, /\.context-liquid \{[^}]*transition: --context-fill [^;]*var\(--motion-ease\);/s);
  const section = adaptive.slice(adaptive.indexOf("/* Context liquid"));
  assert.doesNotMatch(section, /prefers-reduced-motion|data-reduce-animations|animation: none/, "reduced motion stays owned by the global rule");
  assert.doesNotMatch(section, /#[0-9a-f]{3,8}\b/i, "tones come from the theme");
});

let browser: Browser | null = null;
let css = "";

before(async () => {
  if (!CHROME) return;
  const result = await build({
    ...browserBuildOptions,
    entryPoints: [new URL("../../../apps/web/src/main.tsx", import.meta.url).pathname],
    outdir: "/tmp/opencode/context-liquid-build",
    write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  });
  css = result.outputFiles.find((file) => file.path.endsWith("/main.css"))!.text;
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});

after(async () => {
  await browser?.close();
});

test("a pending liquid sample cannot cross model, harness, capacity or compaction boundaries", { skip: !CHROME }, async () => {
  const fixture = await build({
    stdin: {
      resolveDir: process.cwd(), loader: "tsx",
      contents: `
        import { createRoot } from "react-dom/client";
        import { flushSync } from "react-dom";
        import { emptyModel } from "./apps/web/src/reduce.ts";
        import { activateSession, setModels, setSessions } from "./apps/web/src/store.ts";
        import { useActiveContextGauge } from "./apps/web/src/components/ContextLiquid.tsx";
        const root = createRoot(document.getElementById("root"));
        function Probe({ model }) {
          const gauge = useActiveContextGauge(model);
          return <output>{JSON.stringify(gauge)}</output>;
        }
        window.renderContext = ({ modelId = "same", harnessId = "current", source = "native", resetAt, limit }) => {
          const model = emptyModel();
          model.contextResetAt = resetAt;
          const ref = { providerID: "shared", modelID: modelId };
          const contextWindow = source === "request" ? undefined : {
            source, updatedAt: 1, ...(source === "native" ? { fraction: 0.72 } : {}),
          };
          if (source === "request") model.contextUsage = { inputTokens: 32000, cacheReadTokens: 0, cacheWriteTokens: 0, model: ref, harnessId };
          flushSync(() => {
            setModels(limit ? [{ ...ref, name: "Same", harnessId, context: limit }] : []);
            setSessions("context-project", [{ id: "context-session", projectId: "context-project", title: "Context", status: "idle", createdAt: 1, updatedAt: 1, model: ref, resolvedHarnessId: harnessId, contextWindow }]);
            activateSession("context-session");
            root.render(<Probe model={model} />);
          });
          return JSON.parse(document.querySelector("output").textContent);
        };
      `,
    },
    bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    write: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' },
  });
  const page = await browser!.newPage();
  try {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://127.0.0.1:44881/**", (route) => route.fulfill({
      contentType: "text/html", body: '<div id="root"></div>',
    }));
    await page.goto("http://127.0.0.1:44881/");
    await page.addScriptTag({ content: fixture.outputFiles[0]!.text });
    assert.deepEqual(errors, [], "the mounted fixture must initialize without browser errors");
    const render = (options: Record<string, string | number | undefined> = {}) => page.evaluate((value) =>
      (window as unknown as { renderContext: (options: Record<string, string | number | undefined>) => ContextGauge & { pending?: boolean } }).renderContext(value), options);
    assert.equal((await render()).percent, 72);
    const held = await render({ source: "unknown" });
    assert.equal(held.percent, 72);
    assert.equal(held.pending, true);
    for (const change of [{ modelId: "next" }, { harnessId: "next" }, { resetAt: 2 }]) {
      await render();
      const changed = await render({ source: "unknown", ...change });
      assert.equal(changed.percent, null);
      assert.notEqual(changed.pending, true);
    }
    assert.equal((await render({ source: "request", limit: 128_000 })).percent, 25);
    const expired = await render({ source: "request" });
    assert.equal(expired.percent, null);
    assert.notEqual(expired.pending, true);
  } finally {
    await page.close();
  }
});

/** The composer rail around one running primary, mirroring Composer.tsx. */
function railFixture(phone: boolean, percent: number): string {
  const stop = createElement(Icon.stop);
  const send = createElement(QueueSendIcon, { "aria-hidden": "true" });
  const stopButton = markup(createElement("button", { className: "stop composer-stop-primary context-liquid-host", "aria-label": "Stop" },
    stop,
    createElement("span", { className: "composer-action-label" }, "Stop"),
    createElement(ContextLiquid, { gauge: gauge(percent), children: stop })));
  const split = markup(createElement("div", { className: "composer-send-split" },
    createElement("button", { className: "send composer-delivery composer-running-send context-liquid-host", "aria-label": "Send now" },
      send,
      createElement("span", { className: "composer-action-label" }, "Send now"),
      createElement(ContextLiquid, { gauge: gauge(percent), children: send })),
    createElement("button", { className: "composer-send-options", "aria-label": "More" }, createElement(ChevronDownIcon))));
  const composer = (primary: string) => `<div class="composer composer-simple composer-chat${phone ? " composer-mobile composer-expanded composer-has-draft" : ""}"><div class="composer-card"><div class="composer-rail"><div class="composer-actions"><span class="composer-primary">${primary}</span></div></div></div></div>`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
    <body><div class="app"><div id="stop" style="width: 320px">${composer(stopButton)}</div><div id="split" style="width: 320px">${composer(split)}</div>
    <span id="red" style="color: var(--red)"></span><span id="accent" style="color: var(--composer-green)"></span><span id="text" style="color: var(--text)"></span></div></body></html>`;
}

for (const phone of [false, true]) {
  test(`${phone ? "phone" : "desktop"}: the glyph copy sits exactly on the host glyph in the action's own color`, { skip: !CHROME }, async () => {
    const page = await browser!.newPage({
      viewport: { width: phone ? 390 : 1280, height: 600 },
      ...(phone ? { isMobile: true, hasTouch: true } : {}),
    });
    try {
      await page.setContent(railFixture(phone, 42));
      // Phones fill with the solid text-colored action; desktop keeps red Stop
      // and the accent Send.
      const tones = phone ? { stop: "text", split: "text" } : { stop: "red", split: "accent" };
      const measured = await page.evaluate((tones) => {
        const box = (element: Element | null) => {
          const rect = element!.getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 100) / 100);
        };
        return (["stop", "split"] as const).map((id) => {
          const host = document.querySelector(`#${id} .context-liquid-host`)!;
          const front = host.querySelector(".context-liquid-front")!;
          return {
            id,
            glyph: box(host.querySelector(":scope > svg")),
            copy: box(front.querySelector("svg")),
            liquid: getComputedStyle(front).backgroundColor,
            outline: getComputedStyle(host, "::after").borderTopColor,
            expected: getComputedStyle(document.getElementById(tones[id])!).color,
          };
        });
      }, tones);
      for (const item of measured) {
        assert.deepEqual(item.copy, item.glyph, `${item.id}: the submerged glyph copy is pixel-aligned with the host glyph`);
        assert.ok(item.glyph[2]! > 0, `${item.id}: the glyph is laid out`);
        assert.equal(item.liquid, item.expected, `${item.id}: the liquid is the action's solid color`);
        assert.equal(item.outline, item.expected, `${item.id}: the outline shares that color`);
      }
    } finally {
      await page.close();
    }
  });
}

test("reduced motion keeps a still, correct fill level", { skip: !CHROME }, async () => {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 600 }, reducedMotion: "reduce" });
  try {
    await page.setContent(railFixture(false, 50));
    const state = await page.evaluate(() => {
      const front = document.querySelector("#stop .context-liquid-front")!;
      const style = getComputedStyle(front);
      return {
        animation: style.animationName,
        level: style.getPropertyValue("mask-position") || style.getPropertyValue("-webkit-mask-position"),
        running: document.getAnimations().length,
      };
    });
    assert.equal(state.animation, "none");
    assert.equal(state.running, 0);
    assert.match(state.level, /^0px 50%$/, "20% + 50% × 0.6 places the waterline at half height");
  } finally {
    await page.close();
  }
});
