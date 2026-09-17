import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { act, isValidElement } from "react";
import { Window } from "happy-dom";
import type { SlotRegistration, WebPackageHost, WidgetPlugin } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { installVoice } = await import("../widgets/voice.tsx");

test("voice installs per-reply read-aloud and a renderable microphone control", async () => {
  const slots: SlotRegistration[] = [];
  const widgets: WidgetPlugin[] = [];
  const disposed: string[] = [];
  const host = {
    slots: {
      register(definition: SlotRegistration) {
        slots.push(definition);
        return () => { disposed.push(`slot:${definition.id}`); };
      },
    },
    widgets: {
      registerPlugin(plugin: WidgetPlugin) {
        widgets.push(plugin);
        return () => { disposed.push(`widgets:${plugin.id}`); };
      },
    },
  } as unknown as WebPackageHost;

  const dispose = installVoice(host);
  assert.deepEqual(widgets.map((plugin) => plugin.id), ["voice"]);
  assert.deepEqual(slots.map(({ slot, id }) => [slot, id]), [
    ["session.message.actions", "dictation.read-reply"],
  ]);
  assert.ok(isValidElement(slots[0]!.render({
    sessionId: "session-1",
    kind: "assistant",
    messageId: "message-1",
    eventSeq: 7,
  })));

  const dom = new Window();
  Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ available: false }), { status: 200 });
  const { createRoot } = await import("react-dom/client");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  try {
    const widget = widgets[0]!.widgets?.[0];
    assert.ok(widget, "the voice plugin declares a renderable widget");
    await act(async () => { root.render(widget.render({} as never)); });
    assert.ok(container.querySelector(".mic-btn"), "the microphone mounts instead of failing its slot boundary");
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    await dom.happyDOM.close();
  }

  dispose();
  assert.deepEqual(disposed, ["slot:dictation.read-reply", "widgets:voice"]);
});
