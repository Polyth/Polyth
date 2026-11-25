// The run block in the chat follows the activity thread look: text on the
// chat surface, no plate, outline or shadow, one dim status word and at most
// one filled button. happy-dom does not load the package's CSS, so the look
// is pinned on the stylesheet's declared rules.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../widgets/timelineCard.css", import.meta.url), "utf8");
const card = await readFile(new URL("../widgets/WorkflowTimelineCard.tsx", import.meta.url), "utf8");

/** Innermost `selector { declarations }` blocks, comments removed. */
function rules(source: string): Array<{ selectors: string[]; body: string }> {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]!.split(",").map((selector) => selector.trim()).filter(Boolean),
    body: match[2]!,
  }));
}
const declared = (body: string, property: string): string | undefined =>
  body.match(new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`))?.[1]?.trim();

/** A selector whose subject is the block element itself (any state class or
 * pseudo-class, any body/conversation context), not a child or ::before. */
const SELF = /^(?:body\S*\s+)?(?:\.focus-conversation\s+)?\.workflow-timeline-card(?:\.[\w-]+|:(?:is|not|has)\([^)]*\)|:[\w-]+)*$/;

test("the run block declares no plate, outline or shadow", () => {
  const base = rules(css).find((rule) => rule.selectors.includes(".workflow-timeline-card"));
  assert.ok(base, "the block has its own rule");
  assert.equal(declared(base.body, "background"), "transparent");
  assert.equal(declared(base.body, "border"), "0");
  assert.equal(declared(base.body, "box-shadow"), "none");
  assert.equal(declared(base.body, "padding"), "0");
  const painters = rules(css).flatMap((rule) => rule.selectors.filter((selector) => SELF.test(selector)).map((selector) => ({ selector, body: rule.body })))
    .filter(({ body }) => ["background", "background-color", "border", "border-color", "box-shadow", "outline"].some((property) => {
      const value = declared(body, property);
      return value !== undefined && !/^(transparent|0|none)$/.test(value);
    }))
    .map(({ selector }) => selector);
  assert.deepEqual(painters, [], "no state paints the block itself");
});

test("calm states speak in neutral type: a dim status word and no thick bar", () => {
  const pill = rules(css).find((rule) => rule.selectors.includes(".workflow-timeline-pill"));
  assert.equal(declared(pill!.body, "color"), "var(--muted)");
  assert.equal(declared(pill!.body, "font-weight"), "400");
  assert.ok(!rules(css).some((rule) => rule.selectors.some((selector) => /\.workflow-timeline-pill\.status-/.test(selector))),
    "no status colours the word");
  const progress = rules(css).find((rule) => rule.selectors.includes(".workflow-timeline-progress"));
  assert.equal(declared(progress!.body, "height"), "1px", "progress draws no bar");
  assert.ok(!/text-transform\s*:\s*uppercase/.test(css), "no uppercase eyebrow");
  const weights = [...css.matchAll(/font-weight\s*:\s*(\d+)/g)].map((match) => Number(match[1]));
  assert.ok(weights.every((weight) => weight === 400 || (weight >= 550 && weight <= 650)), `weights stay 400 / 550–650: ${weights.join(", ")}`);
});

test("the block's lines are hairlines that survive Hide interface borders", () => {
  // Every intentional line is a background or inset shadow from --borderless-edge.
  const borders = rules(css).filter((rule) => /(?:^|;|\s)border(?:-inline-start|-top|-bottom)?\s*:\s*(?!0\b)[^;]*solid/.test(rule.body));
  assert.deepEqual(borders.map((rule) => rule.selectors.join(", ")), []);
  assert.match(css, /--wf-thread:\s*var\(--borderless-edge\)/);
});

test("the card's own markup offers one filled button at most: a person's reply", () => {
  assert.equal([...card.matchAll(/variant="primary"/g)].length, 1);
  assert.match(card, /primary=\{!agentSteered\}/, "a call the agent owns offers no filled button");
});
