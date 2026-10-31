import test from "node:test";
import assert from "node:assert/strict";
import { handleNativeBack, type NativeBackState } from "../src/nativeMobile.ts";

const closed = (state: Partial<NativeBackState>, escape = false, navigated = false, selection = false) => {
  const calls: string[] = [];
  const handled = handleNativeBack(
    {
      overlayOpen: false,
      drawerOpen: false,
      workspacePaneOpen: false,
      railOpen: false,
      ...state,
    },
    {
      dismissEscapeLayer: () => {
        calls.push("escape");
        return escape;
      },
      dismissSelection: () => {
        if (selection) calls.push("selection");
        return selection;
      },
      closeOverlay: () => calls.push("overlay"),
      closeDrawer: () => calls.push("drawer"),
      closeWorkspacePane: () => calls.push("pane"),
      closeRail: () => calls.push("rail"),
      popPhoneLayer: (layer) => calls.push(`pop:${layer}`),
      navigateBack: () => {
        calls.push("navigate");
        return navigated;
      },
    },
  );
  return { handled, calls };
};

test("native back closes only the frontmost available shell layer", () => {
  assert.deepEqual(
    closed({ overlayOpen: true, drawerOpen: true, workspacePaneOpen: true, railOpen: true }),
    { handled: true, calls: ["escape", "overlay"] },
  );
  assert.deepEqual(
    closed({ drawerOpen: true, workspacePaneOpen: true, railOpen: true }),
    { handled: true, calls: ["escape", "pane"] },
  );
  assert.deepEqual(
    closed({ workspacePaneOpen: true, railOpen: true }),
    { handled: true, calls: ["escape", "pane"] },
  );
  assert.deepEqual(
    closed({ railOpen: true }),
    { handled: true, calls: ["escape", "rail"] },
  );
});

test("native back gives escape layers priority and backgrounds only after navigation ends", () => {
  assert.deepEqual(
    closed({ overlayOpen: true }, true),
    { handled: true, calls: ["escape"] },
  );
  assert.deepEqual(
    closed({}, false, true),
    { handled: true, calls: ["escape", "navigate"] },
  );
  assert.deepEqual(
    closed({}, false, false),
    { handled: false, calls: ["escape", "navigate"] },
  );
});

test("native back clears an active selection only after shell surfaces close", () => {
  assert.deepEqual(
    closed({ drawerOpen: true }, false, false, true),
    { handled: true, calls: ["escape", "drawer"] },
  );
  assert.deepEqual(
    closed({}, false, false, true),
    { handled: true, calls: ["escape", "selection"] },
  );
});

test("phone Back pops one layer of the Workspace stack instead of dismissing it", () => {
  // A package window is a child of the Workspace: Back returns there.
  assert.deepEqual(
    closed({ phoneLayer: "package", workspacePaneOpen: true, railOpen: false }),
    { handled: true, calls: ["escape", "pop:package"] },
  );
  assert.deepEqual(
    closed({ phoneLayer: "package", railOpen: true }),
    { handled: true, calls: ["escape", "pop:package"] },
    "a contextual panel is popped the same way",
  );
  // The Workspace is a child of Chat.
  assert.deepEqual(
    closed({ phoneLayer: "workspace" }),
    { handled: true, calls: ["escape", "pop:workspace"] },
  );
  // Overlays and transient layers still sit above the stack.
  assert.deepEqual(
    closed({ overlayOpen: true, phoneLayer: "package" }),
    { handled: true, calls: ["escape", "overlay"] },
  );
  assert.deepEqual(
    closed({ phoneLayer: "package" }, true),
    { handled: true, calls: ["escape"] },
  );
  // No stack (Chat, or a wider shell): the existing front-to-back order holds.
  assert.deepEqual(
    closed({ phoneLayer: null, workspacePaneOpen: true }),
    { handled: true, calls: ["escape", "pane"] },
  );
});
