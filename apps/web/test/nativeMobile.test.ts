import test from "node:test";
import assert from "node:assert/strict";
import { handleNativeBack, type NativeBackState } from "../src/nativeMobile.ts";

const closed = (state: Partial<NativeBackState>, escape = false, navigated = false) => {
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
      closeOverlay: () => calls.push("overlay"),
      closeDrawer: () => calls.push("drawer"),
      closeWorkspacePane: () => calls.push("pane"),
      closeRail: () => calls.push("rail"),
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
    { handled: true, calls: ["escape", "drawer"] },
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
