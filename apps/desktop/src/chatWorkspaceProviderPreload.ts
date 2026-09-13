import { ipcRenderer } from "electron";

type ActionId = "add-to-agent" | "ask-agent" | "new-agent-chat";

interface ControlsConfig {
  assistantMessageSelectors: string[];
  streamingSelectors: string[];
  actions: Array<{ id: ActionId; label: string }>;
}

interface ActionPayload {
  action: ActionId;
  text: string;
  responseId?: string;
}

const CONFIG_CHANNEL = "polyth-chat-workspace:configure";
const ACTION_CHANNEL = "polyth-chat-workspace:provider-action";
const ROOT_ATTR = "data-polyth-chat-actions";
const ACTION_ATTR = "data-polyth-chat-action";
const MESSAGE_ATTR = "data-polyth-chat-response";
const MAX_TEXT_CHARS = 120_000;

let config: ControlsConfig | null = null;
let observer: MutationObserver | null = null;
let scanQueued = false;
let nextResponseId = 0;

const uniqueElements = (selectors: readonly string[]): HTMLElement[] => {
  const found = new Set<HTMLElement>();
  for (const selector of selectors) {
    try {
      for (const node of document.querySelectorAll(selector)) {
        if (node instanceof HTMLElement) found.add(node);
      }
    } catch {
      // Provider selector drift must never break the page.
    }
  }
  return [...found];
};

const isStreaming = (message: HTMLElement): boolean => {
  if (!config) return false;
  for (const selector of config.streamingSelectors) {
    try {
      if (message.matches(selector) || message.querySelector(selector)) return true;
    } catch {
      // Ignore a stale selector and keep feature detection conservative.
    }
  }
  return false;
};

const responseText = (message: HTMLElement): string => {
  const clone = message.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(`[${ROOT_ATTR}]`).forEach((node) => node.remove());
  return (clone.innerText || clone.textContent || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
};

const makeButton = (action: { id: ActionId; label: string }): HTMLButtonElement => {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute(ACTION_ATTR, action.id);
  button.textContent = action.label;
  button.title = action.label;
  button.style.cssText = [
    "appearance:none",
    "border:0",
    "background:transparent",
    "color:inherit",
    "font:inherit",
    "font-size:11px",
    "font-weight:500",
    "line-height:1",
    "min-height:26px",
    "padding:5px 7px",
    "border-radius:7px",
    "opacity:.58",
    "cursor:pointer",
    "white-space:nowrap",
  ].join(";");
  button.addEventListener("mouseenter", () => { button.style.opacity = ".9"; });
  button.addEventListener("mouseleave", () => { button.style.opacity = ".58"; });
  button.addEventListener("focus", () => { button.style.opacity = ".9"; });
  button.addEventListener("blur", () => { button.style.opacity = ".58"; });
  return button;
};

const installFor = (message: HTMLElement): void => {
  if (!config || isStreaming(message) || message.querySelector(`[${ROOT_ATTR}]`)) return;
  const text = responseText(message);
  if (!text) return;

  const responseId = message.getAttribute(MESSAGE_ATTR) || `response-${++nextResponseId}`;
  message.setAttribute(MESSAGE_ATTR, responseId);

  const controls = document.createElement("div");
  controls.setAttribute(ROOT_ATTR, "true");
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Polyth actions");
  controls.style.cssText = [
    "display:flex",
    "align-items:center",
    "gap:2px",
    "width:max-content",
    "max-width:100%",
    "margin-top:4px",
    "color:inherit",
    "font-family:inherit",
  ].join(";");
  for (const action of config.actions) controls.appendChild(makeButton(action));
  message.appendChild(controls);
};

const scan = (): void => {
  scanQueued = false;
  if (!config || !document.documentElement) return;
  for (const message of uniqueElements(config.assistantMessageSelectors)) installFor(message);
};

const scheduleScan = (): void => {
  if (scanQueued) return;
  scanQueued = true;
  queueMicrotask(scan);
};

const start = (next: ControlsConfig): void => {
  config = {
    assistantMessageSelectors: [...new Set(next.assistantMessageSelectors.filter(Boolean))],
    streamingSelectors: [...new Set(next.streamingSelectors.filter(Boolean))],
    actions: next.actions.filter((action) =>
      action && ["add-to-agent", "ask-agent", "new-agent-chat"].includes(action.id) && Boolean(action.label)),
  };
  observer?.disconnect();
  observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  scheduleScan();
};

document.addEventListener("click", (event) => {
  if (!(event instanceof MouseEvent) || !event.isTrusted || event.button !== 0) return;
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(`button[${ACTION_ATTR}]`) : null;
  if (!target || !config) return;
  const action = target.getAttribute(ACTION_ATTR) as ActionId | null;
  if (!action || !config.actions.some((item) => item.id === action)) return;
  const message = target.closest<HTMLElement>(`[${MESSAGE_ATTR}]`);
  if (!message || isStreaming(message)) return;
  const text = responseText(message);
  if (!text) return;

  event.preventDefault();
  event.stopPropagation();
  const payload: ActionPayload = {
    action,
    text,
    responseId: message.getAttribute(MESSAGE_ATTR) ?? undefined,
  };
  ipcRenderer.send(ACTION_CHANNEL, payload);
}, true);

ipcRenderer.on(CONFIG_CHANNEL, (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const value = raw as Partial<ControlsConfig>;
  if (!Array.isArray(value.assistantMessageSelectors) || !Array.isArray(value.actions)) return;
  start({
    assistantMessageSelectors: value.assistantMessageSelectors.filter((item): item is string => typeof item === "string"),
    streamingSelectors: Array.isArray(value.streamingSelectors)
      ? value.streamingSelectors.filter((item): item is string => typeof item === "string")
      : [],
    actions: value.actions.filter((item): item is { id: ActionId; label: string } =>
      Boolean(item && typeof item === "object"
        && typeof (item as { id?: unknown }).id === "string"
        && typeof (item as { label?: unknown }).label === "string")),
  });
});
