// Instant send: the composer's optimistic prompt echo animates in like any
// arriving prompt, and the canonical row that replaces it must NOT animate
// again. Without the handover rule the reader sees a settled bubble blink.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
for (const name of ["Element", "MutationObserver", "history", "location", "addEventListener"] as const) {
  Object.defineProperty(globalThis, name, {
    value: (dom as unknown as Record<string, unknown>)[name],
    configurable: true,
  });
}

// happy-dom implements no Web Animations API, so the controller takes its
// documented old-WebView fallback and marks entrances with a class.
await import("../src/chatMotion.ts");

const ENTER = "chat-motion-enter";
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function row(className: string, pendingSendId?: string): HTMLElement {
  const el = dom.document.createElement("div") as unknown as HTMLElement;
  el.className = className;
  if (pendingSendId) el.setAttribute("data-pending-send", pendingSendId);
  return el;
}

test("a prompt echo enters, and its canonical replacement hands over silently", async () => {
  const timeline = row("timeline");
  dom.document.body.appendChild(timeline as never);
  await settle();

  const echo = row("msg user msg-pending", "pending-send-1");
  timeline.appendChild(echo as never);
  await settle();
  assert.equal(echo.classList.contains(ENTER), true, "the submitted prompt animates in immediately");

  // One commit: the canonical user row arrives as the echo leaves.
  const canonical = row("msg user");
  timeline.removeChild(echo as never);
  timeline.appendChild(canonical as never);
  await settle();
  assert.equal(canonical.classList.contains(ENTER), false, "the canonical row replaces the echo without replaying");

  // An unrelated prompt arriving later still gets its own entrance.
  const later = row("msg user");
  timeline.appendChild(later as never);
  await settle();
  assert.equal(later.classList.contains(ENTER), true, "handover is consumed, not sticky");
});

test("two echoes handing over at once suppress exactly two canonical rows", async () => {
  const timeline = row("timeline");
  dom.document.body.appendChild(timeline as never);
  await settle();

  const first = row("msg user msg-pending", "pending-send-2");
  const second = row("msg user msg-pending", "pending-send-3");
  timeline.append(first as never, second as never);
  await settle();

  timeline.removeChild(first as never);
  timeline.removeChild(second as never);
  const a = row("msg user");
  const b = row("msg user");
  const c = row("msg user");
  timeline.append(a as never, b as never, c as never);
  await settle();

  assert.deepEqual(
    [a.classList.contains(ENTER), b.classList.contains(ENTER), c.classList.contains(ENTER)],
    [false, false, true],
    "one suppression per retired echo; a genuinely new row still animates",
  );
});
