// Renderer of the small update window: draws updateWindowView() for every
// updater state main publishes and forwards button presses.
import type { DesktopUpdateState } from "./types.ts";
import { updateWindowView, type UpdateWindowAction } from "./updateWindowView.ts";

interface UpdateWindowBridge {
  getState(): Promise<DesktopUpdateState>;
  act(action: UpdateWindowAction): Promise<void>;
  onState(listener: (state: DesktopUpdateState) => void): () => void;
}

const bridge = (window as unknown as { polythUpdate?: UpdateWindowBridge }).polythUpdate;
const byId = (id: string): HTMLElement => document.getElementById(id)!;
const title = byId("title");
const detail = byId("detail");
const progress = byId("progress");
const fill = progress.querySelector<HTMLElement>(".fill")!;
const pct = progress.querySelector<HTMLElement>(".pct")!;
const actions = byId("actions");
const close = byId("close") as HTMLButtonElement;
let shownButtons = "";

const act = (action: UpdateWindowAction, button?: HTMLButtonElement): void => {
  if (button) button.disabled = true;
  void bridge?.act(action).catch(() => {}).finally(() => { if (button) button.disabled = false; });
};

const render = (state: DesktopUpdateState): void => {
  const view = updateWindowView(state);
  title.textContent = view.title;
  title.title = view.title;
  detail.textContent = view.detail;
  detail.title = view.detail;
  document.title = view.title;
  close.hidden = !view.closable;
  if (view.progress === undefined) {
    progress.hidden = true;
  } else {
    progress.hidden = false;
    progress.classList.toggle("indeterminate", view.progress === null);
    if (view.progress === null) {
      fill.style.width = "";
      progress.removeAttribute("aria-valuenow");
    } else {
      fill.style.width = `${Math.round(view.progress * 1000) / 10}%`;
      progress.setAttribute("aria-valuenow", String(Math.round(view.progress * 100)));
    }
    pct.textContent = view.progressLabel ?? "";
  }
  // Progress ticks must not rebuild (and blur) the buttons under the pointer.
  const key = JSON.stringify(view.buttons);
  if (key === shownButtons) return;
  shownButtons = key;
  actions.replaceChildren(...view.buttons.map((spec) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = spec.label;
    if (spec.primary) button.className = "primary";
    button.addEventListener("click", () => act(spec.action, button));
    return button;
  }));
};

close.addEventListener("click", () => act("hide"));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !close.hidden) act("hide");
});

if (bridge) {
  bridge.onState(render);
  void bridge.getState().then(render).catch(() => {});
}
