import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { isValidElement } from "react";
import type { SlotRegistration, WebPackageHost, WidgetPlugin } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { installVoice } = await import("../widgets/voice.tsx");

test("voice installs per-reply read-aloud as an explicit message action", () => {
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

  dispose();
  assert.deepEqual(disposed, ["slot:dictation.read-reply", "widgets:voice"]);
});
