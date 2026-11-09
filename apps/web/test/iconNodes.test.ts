// Vendored Lucide glyphs: icons.ts builds its components from local icon nodes
// (./iconNodes.ts) instead of depending on lucide-react, so this suite pins the
// rendered markup. The literal strings below were captured from
// lucide-react@1.61.0 for the same props; none of these assertions may drift.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const icons = await import("../src/components/ui/icons.ts");

type ComponentLike = { displayName?: string; $$typeof?: symbol };
const isComponent = (value: unknown): value is ComponentLike =>
  (typeof value === "function" || typeof value === "object") &&
  value !== null &&
  String((value as ComponentLike).$$typeof ?? "").includes("react.forward_ref");

const render = (component: ComponentLike, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(component as never, props));

const DEFAULT_ATTRIBUTES = [
  ["xmlns", "http://www.w3.org/2000/svg"],
  ["viewBox", "0 0 24 24"],
  ["fill", "none"],
  ["stroke", "currentColor"],
  ["stroke-width", "2"],
  ["stroke-linecap", "round"],
  ["stroke-linejoin", "round"],
] as const;

test("every icon component renders an svg with Lucide's default attributes", () => {
  const components = (Object.values(icons) as unknown[]).filter(isComponent);
  // The curated map is ~200 glyphs; a lower bound catches an accidental drop
  // without re-pinning the test on every icon addition.
  assert.ok(components.length >= 190, `expected the curated icon map, got ${components.length} components`);

  for (const component of components) {
    const name = component.displayName ?? "(unnamed)";
    assert.ok(name !== "(unnamed)", "every icon component carries its Lucide displayName");
    const markup = render(component);
    assert.ok(markup.startsWith("<svg "), `${name} renders an svg`);
    assert.ok(markup.endsWith("</svg>"), `${name} closes its svg`);
    for (const [attribute, value] of DEFAULT_ATTRIBUTES) {
      assert.ok(markup.includes(` ${attribute}="${value}"`), `${name} keeps ${attribute}="${value}"`);
    }
    assert.match(markup, / width="24" height="24" /, `${name} defaults to 24×24`);
    assert.match(
      markup,
      / class="lucide lucide-[a-z0-9-]+(?: lucide-[a-z0-9-]+)*" aria-hidden="true"><(?:path|circle|rect|line|polyline|polygon|ellipse)/,
      `${name} keeps Lucide's decorative classes`,
    );
  }
});

test("Search, X and Archive render exactly Lucide's markup", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["SearchIcon", { size: 16, strokeWidth: 1.5, className: "a" },
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search a" aria-hidden="true"><path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle></svg>'],
    ["SearchIcon", { absoluteStrokeWidth: true, size: 32 },
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search" aria-hidden="true"><path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle></svg>'],
    ["SearchIcon", { "aria-label": "x" },
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search" aria-label="x"><path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle></svg>'],
    ["CloseIcon", { size: 16, strokeWidth: 1.5, className: "a" },
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x a" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>'],
    ["CloseIcon", { absoluteStrokeWidth: true, size: 32 },
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>'],
    ["CloseIcon", { "aria-label": "x" },
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-label="x"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>'],
    ["ArchiveIcon", { size: 16, strokeWidth: 1.5, className: "a" },
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-archive a" aria-hidden="true"><rect width="20" height="5" x="2" y="3" rx="1"></rect><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path><path d="M10 12h4"></path></svg>'],
    ["ArchiveIcon", { absoluteStrokeWidth: true, size: 32 },
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-archive" aria-hidden="true"><rect width="20" height="5" x="2" y="3" rx="1"></rect><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path><path d="M10 12h4"></path></svg>'],
    ["ArchiveIcon", { "aria-label": "x" },
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-archive" aria-label="x"><rect width="20" height="5" x="2" y="3" rx="1"></rect><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path><path d="M10 12h4"></path></svg>'],
  ];
  for (const [exportName, props, expected] of cases) {
    const component = (icons as unknown as Record<string, ComponentLike | undefined>)[exportName];
    assert.ok(component && isComponent(component), `${exportName} is exported`);
    assert.equal(render(component, props), expected, `${exportName} ${JSON.stringify(props)}`);
  }
});

test("children, aria-hidden overrides and colour pass through like Lucide", () => {
  // Children make the icon non-decorative: Lucide then drops aria-hidden.
  const withTitle = render(icons.SearchIcon, { children: createElement("title", null, "t") });
  assert.ok(withTitle.includes("<title>t</title>"), "children render inside the svg");
  assert.ok(!withTitle.includes("aria-hidden"), "children count as an accessible name");
  assert.match(render(icons.SearchIcon, { color: "red" }), / stroke="red"/);
  assert.match(render(icons.SearchIcon, { size: 12 }), /width="12" height="12"/);
  // Lucide keeps the legacy alias classes for renamed glyphs (Braces shipped as
  // "curly-braces"), so the class list must not be shortened.
  assert.match(render(icons.JsonIcon), / class="lucide lucide-braces lucide-curly-braces"/);
  assert.equal(icons.PlusIcon, icons.AddIcon, "one component backs every alias of a glyph");
  assert.equal(icons.QueueSendIcon.displayName, "QueueSend");
});

test("the icon-node script agrees with the checked-in file", () => {
  const script = new URL("../../../scripts/icons/lucide.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, "check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /sorted, well-formed and all used by icons\.ts/);
});
