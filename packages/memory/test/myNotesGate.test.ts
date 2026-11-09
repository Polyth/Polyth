import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project } from "@polyth/contracts";
import { personalMemoryApi, type MemoryDto } from "../src/client.ts";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost/" });
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: MyNotes, ShareOffer } = await import("../widgets/MyNotes.tsx");
const translate = (key: string) => key;
const emptyPage = { here: [], aboutMe: [], proposals: [], review: [], mode: "auto" as const };
const mount = () => {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  return { container: container as unknown as HTMLElement, root: createRoot(container as unknown as HTMLElement) };
};

test("My notes follows who really works in a project, not who could open it", async () => {
  personalMemoryApi.page = async () => emptyPage;
  const shown = async (fields: Partial<Project>): Promise<boolean> => {
    const { container, root } = mount();
    await act(async () => root.render(createElement(MyNotes, { projectId: "p", project: { id: "p", name: "P", ...fields } as Project, translate })));
    const found = container.querySelector(".memory-mine") !== null;
    await act(async () => root.unmount());
    return found;
  };
  assert.equal(await shown({ sharedWith: 2 }), false, "others could open it, but nobody else is here");
  assert.equal(await shown({ sharedWith: 2, othersHere: true }), true);
});

test("an offer shows under the reply it came with, shares in one act and can be undone", async () => {
  const note = { id: "n1", revision: 1, title: "Dinner", body: "Dinner moved to 19:30.", shareProposedAt: 2_000, sources: [{ kind: "session", sessionId: "s1" }] } as unknown as MemoryDto;
  let proposals = [note];
  const calls: string[] = [];
  const notices: Array<{ kind: string; title: string; actions?: readonly { run(): void | Promise<void> }[] }> = [];
  personalMemoryApi.page = async () => ({ ...emptyPage, proposals });
  personalMemoryApi.publish = async () => { calls.push("publish"); proposals = []; return { memoryId: "copy" } as never; };
  personalMemoryApi.unpublish = async (_project, id, sharedId) => { calls.push(`unpublish ${id} ${sharedId}`); return {} as never; };
  const { container, root } = mount();
  const render = (props: { settled: boolean; latestPromptAt: number }) => act(async () => root.render(createElement(ShareOffer, {
    projectId: "p", sessionId: "s1", translate, notify: (input) => { notices.push(input); }, ...props,
  })));
  const line = () => container.querySelector("[data-memory-share-offer]");

  await render({ settled: false, latestPromptAt: 1_000 });
  assert.equal(line(), null, "not while the agent is still working");
  await render({ settled: true, latestPromptAt: 3_000 });
  assert.equal(line(), null, "the next message lets it go");
  await render({ settled: true, latestPromptAt: 1_000 });
  assert.ok(line(), "it belongs to the latest reply");

  await act(async () => (container.querySelector(".memory-share-confirm") as unknown as HTMLButtonElement).click());
  assert.deepEqual(calls, ["publish"]);
  assert.equal(line(), null, "shared, so the line is gone");
  assert.equal(notices[0]?.title, "memory.share.done");
  await act(async () => { await notices[0]!.actions![0]!.run(); });
  assert.deepEqual(calls, ["publish", "unpublish n1 copy"]);
  assert.equal(line(), null, "undo doesn't ask again");
  await act(async () => root.unmount());
});

test.after(async () => { await dom.happyDOM.close(); });
