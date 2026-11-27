// The waits line above the composer and the navigator's waiting mark: a
// polyth_wait timer reads as the time left and the clock it continues at,
// never its raw "14400 seconds" label, and every awaiting surface draws the
// same waiting clock.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionWait } from "@polyth/contracts";

const dom = new Window();
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
// No motion: the notice row opens in the same frame.
document.documentElement.dataset.reduceAnimations = "true";

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const {
  default: SessionWaitsLine, sessionWaitText, waitClockText, waitRemainingText,
} = await import("../src/components/SessionWaitsLine.tsx");
const { MobileStatusIcon } = await import("../src/components/mobile/MobileStatusIcon.tsx");

// ICU separates "AM"/"PM" with a narrow no-break space; compare plain spaces.
const plain = (text: string) => text.replace(/\s/g, " ");
const at = (days: number, hours: number, minutes: number) => {
  const date = new Date(2026, 10, 27 + days, hours, minutes, 0, 0);
  return date.getTime();
};
const NOW = at(0, 9, 20);
const timer = (deadline: number): SessionWait => ({ id: "w1", kind: "seconds", label: "14400 seconds", since: NOW, deadline });

test("time left reads in whole minutes, rounded up, and seconds only in the last minute", () => {
  assert.equal(waitRemainingText(14_400_000), "4h");
  assert.equal(waitRemainingText(14_399_000), "4h");
  assert.equal(waitRemainingText(3 * 3_600_000 + 51 * 60_000 + 10_000), "3h 52m");
  assert.equal(waitRemainingText(12 * 60_000), "12m");
  assert.equal(waitRemainingText(59_500), "1m");
  assert.equal(waitRemainingText(45_000), "45s");
});

test("the clock has no leading zero and names a day that is not today", () => {
  assert.equal(plain(waitClockText(at(0, 13, 20), NOW)), "1:20 PM");
  assert.equal(plain(waitClockText(at(1, 9, 5), NOW)), "tomorrow 9:05 AM");
  assert.match(plain(waitClockText(at(3, 9, 5), NOW)), /^[A-Z][a-z]{2} 9:05 AM$/);
  assert.match(plain(waitClockText(at(10, 9, 5), NOW)), /^Dec 7, 9:05 AM$/);
});

test("a timer names the time left, then that it continues now; other waits keep their label", () => {
  const lead = sessionWaitText(timer(NOW + 14_400_000), [], NOW);
  assert.equal(lead.text, "Continues in 4h");
  assert.equal(lead.object, "4h");
  assert.equal(sessionWaitText(timer(NOW + 14_400_000), [], NOW + 8 * 60_000 + 30_000).text, "Continues in 3h 52m");
  assert.equal(sessionWaitText(timer(NOW), [], NOW + 1000).text, "Continues now");
  const process: SessionWait = { id: "w2", kind: "pid", label: "process 42 (node)", since: NOW, deadline: NOW + 7_200_000 };
  assert.equal(sessionWaitText(process, [], NOW).text, "Continues after process 42 (node)");
});

test("the mounted line shows a timer as time left and its clock, with the waiting clock mark", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  const deadline = Date.now() + 14_400_000;
  await act(async () => {
    root.render(createElement(SessionWaitsLine, { waits: [timer(deadline)], idle: true }));
  });
  const text = plain(host.querySelector(".session-waits-row")?.textContent ?? "");
  assert.equal(text.includes("seconds"), false, text);
  assert.equal(host.querySelector(".session-waits-object")?.textContent, "4h");
  const meta = [...host.querySelectorAll(".session-waits-meta")].map((node) => plain(node.textContent ?? ""));
  assert.deepEqual(meta, [plain(waitClockText(deadline))]);
  assert.equal(host.querySelector("svg.session-waits-mark")?.getAttribute("class")?.includes("lucide-clock-fading"), true);
  await act(async () => { root.unmount(); });
  host.remove();
});

test("a bounded wait that is not a timer still gives up until its clock", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  const deadline = Date.now() + 2 * 3_600_000;
  const wait: SessionWait = { id: "w3", kind: "pid", label: "process 42 (node)", since: Date.now(), deadline };
  await act(async () => {
    root.render(createElement(SessionWaitsLine, { waits: [wait], idle: true }));
  });
  const meta = [...host.querySelectorAll(".session-waits-meta")].map((node) => plain(node.textContent ?? ""));
  assert.deepEqual(meta, [`until ${plain(waitClockText(deadline))}`]);
  await act(async () => { root.unmount(); });
  host.remove();
});

test("the navigator's awaiting mark is the waiting clock", () => {
  const markup = renderToStaticMarkup(createElement(MobileStatusIcon, { kind: "awaiting" }));
  assert.equal(markup.includes("lucide-clock-fading"), true, markup);
  assert.equal(markup.includes("lucide-hourglass"), false, markup);
});
