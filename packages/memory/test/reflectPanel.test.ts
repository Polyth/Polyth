// Mounted happy-dom tests for the Reflect review panel: loading, error/retry,
// memory-off, empty/pending states, the in-place instruction-file
// confirmation (exact path + line), refusals and localisation.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project } from "@polyth/contracts";
import { ApiError } from "@polyth/web-sdk";
import { reflectApi, type ReflectProposalDto, type ReflectViewDto } from "../src/client.ts";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const project = { id: "p1", name: "Demo", path: "/home/dev/demo" } as unknown as Project;
const proposal = (id: string, rule: string, extra: Partial<ReflectProposalDto> = {}): ReflectProposalDto => ({
  id, projectId: "p1", sessionId: `s-${id}`, sessionTitle: "Fix the build", eventSeq: 12, signal: "always", rule,
  status: "pending", createdAt: 1, ...extra,
});
const view = (over: Partial<ReflectViewDto> = {}): ReflectViewDto => ({
  projectId: "p1", enabled: true, pending: [], recent: [], pendingTotal: 0,
  instructionFiles: [{ file: "AGENTS.md", exists: true }, { file: "CLAUDE.md", exists: false }], instructionWritable: true, ...over,
});

async function harness() {
  const dom = new Window({ url: "http://localhost/" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ReflectPanel } = await import("../widgets/ReflectPanel.tsx");
  const { reflectStrings } = await import("../widgets/reflectStrings.ts");
  // Typed as lib DOM so queries return lib Element types throughout.
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container as never);
  const root = createRoot(container);
  const original = { ...reflectApi };
  const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  return {
    dom, container,
    async mount(props: { locale?: string; memoryOff?: boolean } = {}) {
      await act(async () => root.render(createElement(ReflectPanel, {
        projectId: "p1", project, strings: reflectStrings(props.locale), memoryOff: props.memoryOff ?? false, onMemoryChanged() {},
      })));
      await flush();
    },
    flush,
    button(text: string, scope: ParentNode = container) {
      const found = [...scope.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
      assert.ok(found, `button ${text}`);
      return found as unknown as HTMLButtonElement;
    },
    async click(element: { click(): void }) { await act(async () => element.click()); await flush(); },
    async select(element: Element, value: string) {
      await act(async () => {
        (element as HTMLSelectElement).value = value;
        element.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
      });
      await flush();
    },
    async close() {
      await act(async () => root.unmount());
      Object.assign(reflectApi, original);
      await dom.happyDOM.close();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test("reflect panel shows loading, then a network error with a working retry", async () => {
  const h = await harness();
  let release!: () => void;
  let calls = 0;
  reflectApi.view = () => {
    calls++;
    if (calls === 1) return new Promise((_, reject) => { release = () => reject(new ApiError("network down", 0)); });
    return Promise.resolve(view({ pending: [proposal("a", "Always run tests.")], pendingTotal: 1 }));
  };
  try {
    await h.mount();
    assert.match(h.container.querySelector(".memory-loading[role=status]")?.textContent ?? "", /Loading proposed rules/);
    assert.equal(h.button("Scan recent sessions").disabled, true);
    release(); await h.flush();
    const alert = h.container.querySelector("[role=alert]");
    assert.match(alert?.textContent ?? "", /network down/);
    await h.click(h.button("Retry", alert!));
    assert.equal(h.container.querySelector("[role=alert]")?.textContent ?? null, null);
    assert.match(h.container.textContent ?? "", /1 proposed rule(?!s)/);
    assert.equal(h.container.querySelectorAll(".memory-reflect-card").length, 1);
  } finally { await h.close(); }
});

test("memory off disables detection and scanning but keeps proposals reviewable", async () => {
  const h = await harness();
  reflectApi.view = async () => view({ pending: [proposal("a", "Always run tests.")], pendingTotal: 1 });
  try {
    await h.mount({ memoryOff: true });
    assert.match(h.container.querySelector(".memory-notice-info")?.textContent ?? "", /Project memory is off/);
    assert.equal(h.button("Scan recent sessions").disabled, true);
    assert.equal((h.container.querySelector(".memory-check input") as HTMLInputElement).disabled, true);
    assert.equal(h.button("Approve").disabled, false);
    assert.equal(h.button("Reject").disabled, false);
  } finally { await h.close(); }
});

test("the server's memoryOff flag disables Scan with the explanation even before the policy prop arrives", async () => {
  const h = await harness();
  reflectApi.view = async () => view({ memoryOff: true });
  try {
    await h.mount();
    const scan = h.button("Scan recent sessions");
    assert.equal(scan.disabled, true);
    const note = h.container.querySelector(".memory-notice-info[role=note]");
    assert.match(note?.textContent ?? "", /Turn memory on in Delivery policy/);
    assert.equal(scan.getAttribute("aria-describedby"), note?.id);
  } finally { await h.close(); }
});

test("a 409 memory-off scan refusal shows how to turn memory on instead of an error", async () => {
  const h = await harness();
  reflectApi.view = async () => view();
  reflectApi.scan = async () => { throw new ApiError("Project memory is off, so sessions are not scanned.", 409, "memory-off"); };
  try {
    await h.mount();
    await h.click(h.button("Scan recent sessions"));
    assert.equal(h.container.querySelector("[role=alert]")?.textContent ?? null, null);
    assert.match(h.container.querySelector(".memory-notice-info")?.textContent ?? "", /Project memory is off/);
    assert.equal(h.button("Scan recent sessions").disabled, true);
  } finally { await h.close(); }
});

test("the panel follows a policy change without a reload: off to on, on to off, and a 409 does not stick", async () => {
  const h = await harness();
  let serverOff = true;
  let viewCalls = 0;
  reflectApi.view = async () => { viewCalls++; return view({ memoryOff: serverOff }); };
  const scanDisabled = () => h.button("Scan recent sessions").disabled;
  const offNote = () => h.container.querySelector(".memory-notice-info")?.textContent ?? null;
  try {
    await h.mount({ memoryOff: true });
    assert.equal(scanDisabled(), true);
    // Off -> Read-only: the saved policy re-renders the host with memoryOff
    // false. It applies at once, even while the view re-read is still pending.
    serverOff = false;
    let release!: () => void;
    reflectApi.view = () => new Promise((resolve) => { release = () => resolve(view({ memoryOff: false })); });
    await h.mount({ memoryOff: false });
    assert.equal(scanDisabled(), false, "enabled from the new policy before the view re-read returns");
    assert.equal(offNote(), null);
    release(); await h.flush();
    assert.equal(scanDisabled(), false);
    reflectApi.view = async () => { viewCalls++; return view({ memoryOff: serverOff }); };
    // On -> Off disables again.
    serverOff = true;
    await h.mount({ memoryOff: true });
    assert.equal(scanDisabled(), true);
    assert.match(offNote() ?? "", /Project memory is off/);
    // A scan refused with 409 (policy changed elsewhere) is not remembered
    // past the next policy change.
    serverOff = false;
    await h.mount({ memoryOff: false });
    reflectApi.scan = async () => { throw new ApiError("Project memory is off.", 409, "memory-off"); };
    await h.click(h.button("Scan recent sessions"));
    assert.equal(scanDisabled(), true, "the refusal disables Scan");
    await h.mount({ memoryOff: true });
    await h.mount({ memoryOff: false });
    assert.equal(scanDisabled(), false, "a later policy change clears the remembered refusal");
    assert.ok(viewCalls >= 3, "each policy change re-reads the server view");
  } finally { await h.close(); }
});

test("empty state renders without a list", async () => {
  const h = await harness();
  reflectApi.view = async () => view();
  try {
    await h.mount();
    assert.match(h.container.querySelector(".memory-empty")?.textContent ?? "", /No proposed rules/);
    assert.equal(h.container.querySelector(".memory-reflect-card") === null, true);
  } finally { await h.close(); }
});

test("writing to AGENTS.md is confirmed in place with the exact path and line before any request", async () => {
  const h = await harness();
  let current = view({ pending: [proposal("a", "Always run tests.")], pendingTotal: 1 });
  const approvals: unknown[][] = [];
  reflectApi.view = async () => current;
  reflectApi.approve = async (...args) => {
    approvals.push(args);
    current = view();
    return { proposal: { ...proposal("a", "x"), status: "approved" }, memoryId: "m1", instruction: { status: "appended", file: "AGENTS.md" } };
  };
  try {
    await h.mount();
    await h.click(h.button("Edit"));
    const card = h.container.querySelector(".memory-reflect-card")!;
    const textarea = card.querySelector("textarea")!;
    const { act } = await import("react");
    await act(async () => {
      Object.getOwnPropertyDescriptor(h.dom.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "  - Always   run the   focused tests  ");
      textarea.dispatchEvent(new h.dom.Event("input", { bubbles: true }) as unknown as Event);
    });
    const [category, file] = [...card.querySelectorAll("select")];
    assert.deepEqual([...category!.querySelectorAll("option")].map((o) => o.textContent), ["Convention", "Decision", "Gotcha", "Procedure", "Observation"]);
    assert.deepEqual([...file!.querySelectorAll("option")].map((o) => o.textContent), ["Memory only", "AGENTS.md", "CLAUDE.md (will be created)"]);
    await h.select(file!, "AGENTS.md");
    await h.click(h.button("Approve", card));
    assert.equal(approvals.length, 0, "no request before the in-place confirmation");
    const confirm = card.querySelector(".memory-reflect-confirm[role=group]");
    assert.ok(confirm);
    assert.equal(confirm.querySelector("strong")?.textContent, "Add this line to AGENTS.md?");
    assert.deepEqual([...confirm.querySelectorAll("code")].map((code) => code.textContent), ["/home/dev/demo/AGENTS.md", "- Always run the focused tests"]);
    assert.deepEqual([...confirm.querySelectorAll("code")].map((code) => code.getAttribute("dir")), ["ltr", "ltr"]);
    assert.equal(h.dom.document.activeElement?.textContent, "Approve and add line", "focus moves into the confirmation");
    assert.equal(card.querySelector(".memory-card-actions") === null, true, "card actions are replaced while confirming");
    await h.click(h.button("Cancel", confirm));
    assert.equal(card.querySelector(".memory-reflect-confirm") === null, true);
    assert.equal(approvals.length, 0);
    await h.click(h.button("Approve", card));
    await h.click(h.button("Approve and add line", card.querySelector(".memory-reflect-confirm")!));
    assert.equal(approvals.length, 1);
    assert.deepEqual(approvals[0]!.slice(1), ["a", { rule: "- Always   run the   focused tests", category: "convention" }, "AGENTS.md"]);
    assert.equal(h.container.querySelector(".memory-notice-success")?.textContent, "Saved as a locked project memory. Added to AGENTS.md.");
  } finally { await h.close(); }
});

test("a refused instruction write (symlink / outside root) is a readable warning, not a raw code", async () => {
  const h = await harness();
  reflectApi.view = async () => view({ pending: [proposal("a", "Always run tests.")], pendingTotal: 1 });
  reflectApi.approve = async () => ({ proposal: { ...proposal("a", "x"), status: "approved" }, instruction: { status: "failed", file: "AGENTS.md", code: "invalid-path" } });
  try {
    await h.mount();
    await h.click(h.button("Edit"));
    await h.select(h.container.querySelectorAll(".memory-reflect-card select")[1]!, "AGENTS.md");
    await h.click(h.button("Approve"));
    await h.click(h.button("Approve and add line"));
    const warning = h.container.querySelector(".memory-notice-warning[role=status]");
    assert.equal(warning?.textContent, "Saved as a locked project memory. AGENTS.md was not changed: it is a symbolic link or outside the project root. The memory is still saved.");
    assert.doesNotMatch(warning?.textContent ?? "", /invalid-path/);
  } finally { await h.close(); }
});

test("reject is final and a failed action surfaces an alert", async () => {
  const h = await harness();
  let current = view({ pending: [proposal("a", "Always run tests."), proposal("b", "Never push.")], pendingTotal: 2 });
  const rejected: string[] = [];
  reflectApi.view = async () => current;
  reflectApi.reject = async (_projectId, id) => {
    if (id === "b") throw new ApiError("proposal was already approved", 409, "conflict");
    rejected.push(id);
    current = view({ pending: [proposal("b", "Never push.")], pendingTotal: 1 });
    return { ...proposal(id, "x"), status: "rejected" };
  };
  try {
    await h.mount();
    assert.match(h.container.textContent ?? "", /2 proposed rules/);
    await h.click(h.button("Reject", h.container.querySelectorAll(".memory-reflect-card")[0]!));
    assert.deepEqual(rejected, ["a"]);
    assert.match(h.container.querySelector("[role=status]")?.textContent ?? "", /will not be proposed again/);
    await h.click(h.button("Reject"));
    assert.match(h.container.querySelector("[role=alert]")?.textContent ?? "", /already approved/);
  } finally { await h.close(); }
});

test("an approved rule can be written later after the same confirmation", async () => {
  const h = await harness();
  const writes: string[] = [];
  reflectApi.view = async () => view({ recent: [proposal("r", "Never push to master.", { status: "approved", decidedAt: 2 })] });
  reflectApi.writeInstruction = async (_projectId, id, file) => {
    writes.push(`${id}:${file}`);
    return { proposal: proposal("r", "x"), instruction: { status: "duplicate", file } };
  };
  try {
    await h.mount();
    await h.click(h.button("Add to CLAUDE.md"));
    const confirm = h.container.querySelector(".memory-reflect-confirm")!;
    assert.deepEqual([...confirm.querySelectorAll("code")].map((code) => code.textContent), ["/home/dev/demo/CLAUDE.md", "- Never push to master."]);
    assert.equal(writes.length, 0);
    await h.click(h.button("Add line", confirm));
    assert.deepEqual(writes, ["r:CLAUDE.md"]);
    assert.equal(h.container.querySelector("[role=status]")?.textContent, "CLAUDE.md already contains this rule.");
  } finally { await h.close(); }
});

test("remote projects explain why instruction files cannot be written", async () => {
  const h = await harness();
  reflectApi.view = async () => view({ pending: [proposal("a", "Always run tests.")], pendingTotal: 1, instructionWritable: false });
  try {
    await h.mount();
    assert.match(h.container.textContent ?? "", /only be written for local projects/);
    await h.click(h.button("Edit"));
    assert.equal((h.container.querySelectorAll(".memory-reflect-card select")[1] as HTMLSelectElement).disabled, true);
  } finally { await h.close(); }
});

test("Ukrainian strings cover the panel, categories and refusal reasons", async () => {
  const h = await harness();
  reflectApi.view = async () => view({ pending: [proposal("a", "Завжди запускай тести.")], pendingTotal: 1 });
  try {
    await h.mount({ locale: "uk" });
    assert.equal(h.container.querySelector("h3")?.textContent, "Вивчено з ваших виправлень");
    assert.equal(h.container.querySelector(".memory-reflect")?.getAttribute("lang"), "uk");
    await h.click(h.button("Редагувати"));
    const options = [...h.container.querySelectorAll(".memory-reflect-card select")[0]!.querySelectorAll("option")].map((o) => o.textContent);
    assert.deepEqual(options, ["Домовленість", "Рішення", "Пастка", "Процедура", "Спостереження"]);
    const { reflectStrings, failureReason } = await import("../widgets/reflectStrings.ts");
    const uk = reflectStrings("uk");
    const en = reflectStrings("en");
    assert.deepEqual(Object.keys(uk).sort(), Object.keys(en).sort());
    assert.match(failureReason(uk, "invalid-path"), /символьне посилання/);
    assert.equal(failureReason(en, "something-new"), en["reason_write-failed"]);
  } finally { await h.close(); }
});

test("reflect panel shows durability and area badges, and toggles hidden proposals", async () => {
  const h = await harness();
  const visible = proposal("p1", "Always run focused tests.", { durability: 0.85, area: "process" });
  const hidden = proposal("p2", "No, use port 3001 today.", { durability: 0.15, area: "code" });
  reflectApi.view = async () => view({
    pending: [visible],
    pendingTotal: 1,
    hidden: [hidden],
    hiddenTotal: 1,
  });
  try {
    await h.mount();
    // Check visible card has area and percentage badges
    const visibleCard = h.container.querySelector(".memory-reflect-card")!;
    assert.ok(visibleCard);
    assert.match(visibleCard.textContent ?? "", /Process/);
    assert.match(visibleCard.textContent ?? "", /85%/);

    // Show hidden affordance exists
    const showHiddenBtn = h.button("Show hidden (1)");
    assert.ok(showHiddenBtn);

    // Hidden card is not rendered yet
    assert.equal(h.container.querySelectorAll(".memory-reflect-card").length, 1);

    // Click Show hidden (1)
    await h.click(showHiddenBtn);

    // Now both cards are rendered
    assert.equal(h.container.querySelectorAll(".memory-reflect-card").length, 2);
    const hiddenCard = h.container.querySelectorAll(".memory-reflect-card")[1]!;
    assert.match(hiddenCard.textContent ?? "", /Code/);
    assert.match(hiddenCard.textContent ?? "", /15%/);
    assert.match(hiddenCard.textContent ?? "", /port 3001/);

    // Button label changed to Hide hidden
    const hideBtn = h.button("Hide hidden");
    assert.ok(hideBtn);

    // Click to hide again
    await h.click(hideBtn);
    assert.equal(h.container.querySelectorAll(".memory-reflect-card").length, 1);
  } finally { await h.close(); }
});
