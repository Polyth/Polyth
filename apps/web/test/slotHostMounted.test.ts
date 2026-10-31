// EXT-SEAMS-V1 regression, mounted through a real React root: a contribution
// that throws is isolated by its boundary, and a same-id replacement of the
// registration must *visibly recover* — the audit caught SlotBoundary keeping
// { failed: true } forever because the host keys boundaries by contribution id.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

// happy-dom globals must exist before react-dom/client initializes.
const dom = new Window();
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerSlot } = await import("../src/slots.ts");
const { default: SlotHost } = await import("../src/components/slots/SlotHost.ts");

test("mounted host: throw → same-id replacement → visible recovery, sibling intact", async () => {
  // Boundary failures log through console.error (React + componentDidCatch);
  // collect them so the test output stays clean and the catch is provable.
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const offs: Array<() => void> = [];
  try {
    offs.push(registerSlot("composer.leading", "sibling",
      () => createElement("span", { className: "sibling" }, "sibling"), 1));
    offs.push(registerSlot("composer.leading", "flaky",
      () => { throw new Error("broken contribution"); }, 0));

    await act(async () => {
      root.render(createElement(SlotHost, { slot: "composer.leading", context: {} }));
    });

    // The throwing contribution disappears alone; its healthy sibling renders.
    assert.equal(container.textContent, "sibling");
    assert.ok(errors.some((e) => e.includes("flaky")), "boundary reported the failing contribution");
    const siblingNode = container.querySelector(".sibling");
    assert.ok(siblingNode);

    // Same-id replacement (a fixed / hot-reloaded contribution) must recover
    // without disposing first and without remounting the host.
    await act(async () => {
      offs.push(registerSlot("composer.leading", "flaky",
        () => createElement("em", { className: "fixed" }, "recovered"), 0));
    });
    assert.equal(container.textContent, "recoveredsibling");
    // Stable contribution keying: the sibling kept its exact DOM node.
    assert.equal(container.querySelector(".sibling"), siblingNode);

    // The reset must not disarm the boundary: a broken replacement fails
    // closed again, still without touching the sibling.
    await act(async () => {
      offs.push(registerSlot("composer.leading", "flaky",
        () => { throw new Error("broken again"); }, 0));
    });
    assert.equal(container.textContent, "sibling");

    // …and a second same-id fix recovers a second time.
    await act(async () => {
      offs.push(registerSlot("composer.leading", "flaky",
        () => createElement("em", null, "recovered twice"), 0));
    });
    assert.equal(container.textContent, "recovered twicesibling");
  } finally {
    console.error = originalError;
    await act(async () => {
      for (const off of offs) off();
      root.unmount();
    });
    container.remove();
  }
});

test("mounted host: late registration and disposal re-render without remounting", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(SlotHost, { slot: "session.header.actions", context: {} }));
    });
    assert.equal(container.textContent, "");

    let off = () => {};
    await act(async () => {
      off = registerSlot("session.header.actions", "late",
        () => createElement("button", null, "late action"));
    });
    assert.equal(container.textContent, "late action");

    await act(async () => { off(); });
    assert.equal(container.textContent, "");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
