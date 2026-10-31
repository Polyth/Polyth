import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { browserBuildOptions, uiFontScalePlugin } from "../../../apps/web/buildConfig.ts";
import type { Browser, Page } from "playwright-core";
import { findChromiumExecutable } from "@polyth/browser/chromium";

const readCss = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
const CHROME = await findChromiumExecutable();

// Build the real entry graph in memory: CSS order includes dynamic bootstrap
// imports (not just the import lines in main.tsx). No app/server writes.
let compiledStyles: Promise<string> | undefined;
async function composerStyles() {
  return compiledStyles ??= buildComposerStyles();
}

async function buildComposerStyles() {
  const result = await build({
    ...browserBuildOptions,
    entryPoints: [new URL("../../../apps/web/src/main.tsx", import.meta.url).pathname],
    outdir: "/tmp/opencode/composer-geometry-build",
    write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  });
  return result.outputFiles.find((file) => file.path.endsWith("/main.css"))!.text;
}

/** Phone composer fixture with several contributed controls. `state` selects
 *  the resting row (add · placeholder · voice · Send) or the engaged rail; the
 *  trailing slot holds the host's own prompt-improve / "magic" widget, which
 *  is the control reported as unwanted in the resting row. */
function railFixture(state: "collapsed" | "expanded", leading: number, trailing: number) {
  const glyph = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 5v14M5 12h14"/></svg>';
  const control = (cls: string, label: string) => `<span class="placed-mini-widget"><button class="${cls}" aria-label="${label}">${glyph}</button></span>`;
  const leadClasses = ["mic-btn", "header-action composer-auto-approve", "header-action composer-goals", "header-action composer-workflow"];
  const configRow = state === "expanded"
    ? '<div class="composer-config composer-config-row"><span class="picker picker-model"><span class="model-picker"><button class="config-chip model-picker-trigger"><span class="model-trigger-name">Union Alpha</span></button></span></span></div>'
    : '<div class="composer-config composer-config-row"></div>';
  const trailingLane = `<span class="composer-extensions">${`<span class="placed-mini-widget"><span class="composer-next-action"><button class="ui-icon-btn ui-icon-btn--ghost ui-icon-btn--sm" aria-label="trail">${glyph}</button></span></span>`.repeat(trailing)}</span>`;
  return `<div class="stage-new"><div class="hero-dock">
    <div class="composer composer-simple composer-chat composer-focus-light composer-mobile composer-${state}">
      <div class="composer-card glass-dock">
        ${configRow}
        <div class="composer-input"><textarea class="composer-editor" rows="1" placeholder="Message Polyth…"></textarea></div>
        <div class="composer-rail">
          <span class="composer-leading-zone customize-zone"><div class="composer-add"><button class="composer-add-trigger" aria-label="Add">${glyph}</button></div>
            <span class="composer-extensions composer-mobile-extensions">${leadClasses.slice(0, leading).map((cls, i) => control(cls, `lead${i}`)).join("")}</span></span>
          <span class="composer-execution"></span>
          <div class="composer-actions customize-zone">${trailingLane}
            <span class="composer-primary"><button class="send" aria-label="Send">${glyph}</button></span></div>
        </div>
      </div>
    </div></div></div>`;
}

const engagedRailFixture = (leading: number, trailing: number) => railFixture("expanded", leading, trailing);

/** Measure every control in the engaged rail against the card and the scroll
 *  lane that clips it. */
function railGeometry(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector<HTMLElement>(".composer-card")!.getBoundingClientRect();
    const rail = document.querySelector<HTMLElement>(".composer-rail")!;
    const controls = [...rail.querySelectorAll("button")].map((button) => {
      const r = button.getBoundingClientRect();
      const lane = button.closest<HTMLElement>(".composer-extensions")?.getBoundingClientRect() ?? r;
      return {
        label: button.getAttribute("aria-label") ?? "",
        left: r.left,
        right: r.right,
        width: r.width,
        visible: Math.max(0, Math.min(r.right, lane.right) - Math.max(r.left, lane.left)),
        insideCard: r.left >= card.left - 0.5 && r.right <= card.right + 0.5,
      };
    });
    const gaps = controls.slice(1).map((control, i) => +(control.left - controls[i]!.right).toFixed(1));
    return {
      controls,
      gaps,
      overflow: rail.scrollWidth - rail.clientWidth,
      cardRight: card.right,
    };
  });
}

let browser: Browser | null = null;
let page: Page | null = null;

before(async () => {
  if (!CHROME) return;
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
});

after(async () => {
  await browser?.close();
});

test("the phone composer stays in visual-viewport flow and expands inside the visible band", async () => {
  const css = await readCss("../../../apps/web/src/styles.css");
  const viewportCss = await readCss("../../../apps/web/src/mobileViewport.css");

  // The side gutters may read the horizontal insets, but the block-end inset
  // belongs to the surrounding dock/nav alone.
  const phoneComposer = css.match(/\.composer-chat\.composer-mobile \{[^}]*\}/)?.[0] ?? "";
  assert.match(phoneComposer, /padding: var\(--space-1\)/,
    "the phone composer owns its own compact block padding");
  assert.doesNotMatch(
    phoneComposer,
    /--safe-bottom/,
    "the composer does not duplicate the dock or navigator safe-area inset",
  );
  assert.match(
    css,
    /\.composer-mobile\.composer-expanded \.composer-card textarea \{ min-height: var\(--tap\); \}/,
    "the expanded editor rests at one touch row and grows from there, without a fixed card height",
  );
  assert.doesNotMatch(
    css,
    /body\[data-keyboard="open"\][\s\S]{0,180}\.composer-chat\.composer-mobile\s*\{[^}]*position:\s*fixed/s,
    "keyboard-open composition remains in visualViewport flow",
  );
  assert.match(
    css,
    /body\[data-keyboard="open"\] \.composer-chat\.composer-mobile,\s*body\[data-keyboard="open"\] \.hero-dock \{ padding-bottom: var\(--space-1\); \}/,
    "new-chat and in-session composers share the keyboard-open optical gap",
  );
  assert.match(
    viewportCss,
    /body\[data-keyboard="open"\] \.hero-dock\s*\{[^}]*padding-bottom:\s*var\(--space-1\)/s,
    "the viewport overlay targets the new-chat dock itself",
  );
  assert.doesNotMatch(
    viewportCss,
    /#app-canvas-root/,
    "the keyboard-open dock rule cannot depend on a host id that is never rendered",
  );
});

test("keyboard-open new chat drops the home-indicator gap that existing chats already drop", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = [
    await readCss("../../../apps/web/src/tokens.css"),
    await readCss("../../../apps/web/src/styles.css"),
    await readCss("../../../apps/web/src/mobileViewport.css"),
  ].join("\n");
  await page.setContent(`<style>${css}</style>
    <div class="hero-dock" id="new-chat"><div class="composer composer-chat composer-mobile">draft</div></div>
    <div class="composer composer-chat composer-mobile" id="session">draft</div>`);
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-area-inset-bottom", "34px");
    document.documentElement.style.setProperty("--safe-bottom", "34px");
  });

  const resting = await page.evaluate(() => {
    const dock = getComputedStyle(document.getElementById("new-chat")!);
    const session = getComputedStyle(document.getElementById("session")!);
    return { dock: dock.paddingBottom, session: session.paddingBottom };
  });
  assert.equal(resting.dock, "34px", "new-chat dock keeps the home indicator while the keyboard is closed");

  await page.evaluate(() => { document.body.dataset.keyboard = "open"; });
  const open = await page.evaluate(() => {
    const dock = getComputedStyle(document.getElementById("new-chat")!);
    const session = getComputedStyle(document.getElementById("session")!);
    return { dock: dock.paddingBottom, session: session.paddingBottom };
  });
  assert.equal(open.session, "4px", "existing chats keep the compact keyboard-open gap");
  assert.equal(open.dock, "4px", "new chats use that same compact keyboard-open gap");
});

test("an engaged phone rail distributes contributed controls instead of clipping a capped lane", { skip: !CHROME }, async () => {
  assert.ok(page);
  const styles = await composerStyles();
  await page.setViewportSize({ width: 430, height: 844 });
  await page.setContent(`<style>${styles}</style>${engagedRailFixture(4, 1)}`);

  const g = await railGeometry(page);
  assert.equal(g.controls.length, 7, "Add, five contributed controls and Send share the row");
  // The reported defect: one control sat in a capped, clipped lane and the
  // rest of the row opened a hole in the middle.
  const clipped = g.controls.filter((c) => c.visible < c.width - 0.5).map((c) => c.label);
  assert.deepEqual(clipped, [], "every contributed control keeps its full touch box on a phone wide enough for the row");
  assert.deepEqual(g.controls.filter((c) => !c.insideCard).map((c) => c.label), [], "no control leaves the composer card");
  assert.ok(g.overflow <= 0, `the engaged rail never overflows its own row (${g.overflow}px)`);
  // Two blocks with one rhythm: every gap inside a block uses the rail's 7px,
  // and the only wider gap is the single separation before the trailing block.
  const wider = g.gaps.filter((gap) => gap > 8);
  assert.equal(
    wider.length,
    1,
    `only the block separation may be wider than the row rhythm (gaps ${g.gaps.join(", ")})`,
  );
  assert.ok(wider[0]! <= 64, `the block separation stays bounded (${wider[0]}px)`);
  assert.ok(
    g.gaps.slice(0, 4).every((gap) => Math.abs(gap - 7) <= 0.5),
    `Add and every contributed control share one gap (gaps ${g.gaps.join(", ")})`,
  );

  // Causal control A: restore the capped lanes this test exists to reject and
  // the same fixture clips a contributed control again.
  await page.addStyleTag({ content: `
    .composer-mobile.composer-expanded .composer-mobile-extensions,
    .composer-mobile.composer-expanded .composer-actions > .composer-extensions { max-width: min(30vw, 140px) !important; }
  ` });
  const capped = await railGeometry(page);
  assert.ok(
    capped.controls.some((c) => c.visible < c.width - 0.5),
    "the rejected capped-lane rail clips a contributed control in this same fixture",
  );

  // Causal control B: the shape before this fix distributed the free space with
  // space-between over a 2px rail gap and flattened the leading wrapper, which
  // left three different gap sizes — reported as icons that are not aligned.
  await page.setContent(`<style>${styles}</style>${engagedRailFixture(4, 1)}`);
  await page.addStyleTag({ content: `
    .composer-mobile.composer-expanded .composer-leading-zone { display: contents !important; }
    .composer-mobile.composer-expanded .composer-rail { justify-content: space-between !important; gap: calc(var(--space-1) / 2) !important; }
    .composer-mobile.composer-expanded .composer-actions { margin-inline-start: 0 !important; }
  ` });
  const distributed = await railGeometry(page);
  assert.ok(
    distributed.gaps.filter((gap) => gap > 8).length >= 2,
    `the rejected distributed rail breaks the row rhythm (gaps ${distributed.gaps.join(", ")})`,
  );
});

test("a phone too narrow for every control still keeps full touch boxes reachable", { skip: !CHROME }, async () => {
  assert.ok(page);
  const styles = await composerStyles();
  await page.setViewportSize({ width: 360, height: 780 });
  await page.setContent(`<style>${styles}</style>${engagedRailFixture(4, 1)}`);

  const g = await railGeometry(page);
  // The shortfall is shared: both lanes lose a little, none of them is hidden
  // behind the primary action, and Add and Send keep their whole box.
  const byLabel = new Map(g.controls.map((c) => [c.label, c]));
  for (const label of ["Add", "Send"]) {
    const control = byLabel.get(label)!;
    assert.ok(control.visible >= control.width - 0.5, `${label} keeps its full touch box at 360px`);
    assert.ok(control.insideCard, `${label} stays inside the composer card at 360px`);
  }
  assert.ok(g.overflow <= 0, `the squeezed rail still does not overflow (${g.overflow}px)`);
  for (const control of g.controls) {
    assert.ok(control.visible > 16, `${control.label} keeps a tappable sliver instead of collapsing to nothing`);
  }
});

test("the resting phone row is Add · input · Mic · Send with the mic flush against Send", { skip: !CHROME }, async () => {
  assert.ok(page);
  const styles = await composerStyles();
  await page.setViewportSize({ width: 430, height: 844 });
  // The reported shape: several contributed leading controls plus the host's
  // prompt-improve ("magic") widget in the trailing slot.
  await page.setContent(`<style>${styles}</style>${railFixture("collapsed", 4, 1)}`);

  const g = await railGeometry(page);
  const byLabel = new Map(g.controls.map((c) => [c.label, c]));
  const magic = byLabel.get("trail");
  assert.ok(magic, "the fixture still mounts the contributed trailing control");
  assert.ok(magic.visible <= 0.5, "the resting row carries no prompt-improve control beside Send");
  const mic = byLabel.get("lead0");
  assert.ok(mic, "dictation stays in the resting row");
  assert.ok(mic.visible >= mic.width - 0.5, `the microphone keeps its full touch box at rest (${mic.visible}px)`);
  assert.ok(mic.insideCard, "the microphone stays inside the composer card");
  const send = byLabel.get("Send")!;
  const gap = +(send.left - mic.right).toFixed(1);
  assert.ok(gap >= 0 && gap <= 8, `the microphone sits flush against Send (gap ${gap}px)`);
  assert.deepEqual(
    g.controls.filter((c) => c.visible > 0.5).map((c) => c.label),
    ["Add", "lead0", "Send"],
    "the resting row exposes exactly the add, input-method and primary controls",
  );
  assert.ok(g.overflow <= 0, `the resting row cannot overflow the card (${g.overflow}px)`);

  // Causal control: with the pre-fix resting rules the same fixture squeezes
  // the input method below one tap and parks the contributed trailing control
  // beside Send — the row reported from the phone.
  await page.addStyleTag({ content: `
    .composer-mobile.composer-collapsed .composer-mobile-extensions { width: auto !important; max-width: min(30vw, 140px) !important; flex: 0 1 auto !important; }
    .composer-mobile.composer-collapsed .composer-actions > .composer-extensions { display: inline-flex !important; }
  ` });
  const before = await railGeometry(page);
  const beforeMic = before.controls.find((c) => c.label === "lead0")!;
  const beforeMagic = before.controls.find((c) => c.label === "trail")!;
  assert.ok(beforeMagic.visible > 0.5, "the rejected resting row shows the contributed trailing control");
  const beforeGap = +(before.controls.find((c) => c.label === "Send")!.left - beforeMic.right).toFixed(1);
  assert.ok(
    Math.abs(beforeGap - gap) > 8,
    `and it pushes the microphone away from Send (${beforeGap}px against the fixed ${gap}px)`,
  );
});

test("the phone composer reads more transparent than shared chrome and stays opaque when glass is off", { skip: !CHROME }, async () => {
  assert.ok(page);
  const styles = await composerStyles();
  await page.setViewportSize({ width: 390, height: 844 });
  // The real dock shape: GlassDock mints `ui-glass-dock` + `composer-card`;
  // the shorter fixtures above omit the glass classes on purpose.
  const fixture = `<div class="app mode-chat view-session"><div class="focus-conversation"><div class="conversation-composer-dock">
    <div class="composer composer-simple composer-chat composer-mobile composer-collapsed">
      <div class="composer-card ui-glass-dock ui-glass-dock--strong"><textarea class="composer-editor"></textarea></div>
    </div>
  </div></div></div>`;
  await page.setContent(`<style>${styles}</style>${fixture}`);
  await page.evaluate(() => { document.body.dataset.glass = "matte"; });

  const readCenterAlpha = () => page!.evaluate(() => {
    const value = getComputedStyle(document.querySelector(".composer-card")!).backgroundImage;
    return Number(value.match(/\/\s*([\d.]+)\)/)?.[1] ?? NaN);
  });

  const alpha = await readCenterAlpha();
  assert.ok(Number.isFinite(alpha) && alpha >= 0.6, `the phone composer keeps a readable glass fill (${alpha})`);

  // Causal control: the shared chrome recipe this override exists to soften
  // puts the full readable fill back on the same fixture.
  await page.addStyleTag({ content: `
    body:not([data-glass="off"]):not([data-desktop-low-resource="true"]) .composer.composer-simple.composer-mobile .ui-glass-dock.composer-card {
      background: radial-gradient(140% 140% at 50% 50%,
        color-mix(in srgb, var(--material-glass) var(--material-glass-readable-fill), transparent) 0%,
        color-mix(in srgb, var(--material-glass) var(--material-glass-readable-edge), transparent) 100%) !important;
    }
  ` });
  const shared = await readCenterAlpha();
  assert.ok(
    shared > alpha + 0.05,
    `the rejected chrome recipe paints the full readable fill (${shared} vs ${alpha})`,
  );

  // `data-glass="off"` remains the explicit opaque choice: no gradient, no blur.
  await page.setContent(`<style>${styles}</style>${fixture}`);
  await page.evaluate(() => { document.body.dataset.glass = "off"; });
  const opaque = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector(".composer-card")!);
    return { image: cs.backgroundImage, filter: cs.backdropFilter };
  });
  assert.equal(opaque.image, "none", "glass-off keeps an opaque composer, not a gradient");
  assert.equal(opaque.filter, "none", "glass-off drops the composer blur");
});

test("the new-chat dock never clips the composer's snippet/command picker", { skip: !CHROME }, async () => {
  assert.ok(page);
  const styles = await composerStyles();
  await page.setViewportSize({ width: 430, height: 520 });
  // Reported shape: a fresh chat with the keyboard up and `#` typed. The
  // picker is anchored above the editor, so it extends past the dock's top.
  const fixture = `<div class="stage-new" style="display:flex;flex-direction:column;height:100vh">
    <div style="flex:1"></div>
    <div class="hero-dock">
      <div class="session-context-bar" style="min-height:44px">Polyth · master</div>
      <div class="composer composer-simple composer-chat composer-mobile composer-expanded">
        <div class="composer-card glass-dock">
          <div class="composer-input"><textarea class="composer-editor" rows="1">#</textarea>
            <div class="ac-popup" data-kind="snip">
              <div class="ac-header"><span class="ac-header-title">Snippets</span></div>
              <div class="ac-list"><div class="ac-item">#session-supervisor</div></div>
              <div class="ac-footer">navigate</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
  await page.setContent(`<style>${styles}</style>${fixture}`);
  const hit = () => page!.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".ac-header")!.getBoundingClientRect();
    const dock = document.querySelector<HTMLElement>(".hero-dock")!.getBoundingClientRect();
    const target = document.elementFromPoint(header.left + 8, header.top + header.height / 2);
    return { aboveDock: header.top < dock.top, visible: !!target?.closest(".ac-header") };
  });

  const fixed = await hit();
  assert.ok(fixed.aboveDock, "the fixture places the picker header above the dock box");
  assert.ok(fixed.visible, "the picker header paints above the dock instead of being clipped");

  // Causal control: the dock's scroll guard alone clips the same header.
  await page.addStyleTag({ content: ".stage-new .hero-dock { overflow-y: auto !important; }" });
  assert.equal((await hit()).visible, false, "the rejected scroll guard clips the picker header");
});
