// Native Desktop driver: drives a page of a host-provided native web view
// purely through its Chrome DevTools Protocol session. chromium.ts (Playwright)
// is the behavioral reference for every method; this file re-implements the
// same contract on raw CDP so the page lives in the Desktop app's own Chromium
// instead of a separate automation browser. The host owns the view's lifecycle
// and request policy (guardRequest); this driver only drives the page.
import type { BrowserColorScheme, BrowserTarget, JsonObject } from "@polyth/contracts";
import type { NativeWebView, NativeWebViewHost, NativeWebViewGoneReason } from "@polyth/plugins";
import type { BrowserDriver, DriverFrame, DriverNav, DriverPage, DriverPageEvent } from "./driver.ts";
import { redactUrl } from "./redact.ts";

/** Page-side hit-test / focus inspect. Copied from chromium.ts (not exported there); keep in sync. */
function describeHit(args: { x?: number; y?: number; preferFocus?: boolean; focusedOnly?: boolean; region?: { x: number; y: number; width: number; height: number } }): Record<string, unknown> {
  const quote = (value: string) =>
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(value)
      : value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
  const unique = (selector: string) => {
    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
  };
  const selectorFor = (node: Element): string => {
    const testId = node.getAttribute("data-testid");
    if (testId) {
      const candidate = `[data-testid="${testId.replace(/["\\]/g, "\\$&")}"]`;
      if (unique(candidate)) return candidate;
    }
    if (node.id) {
      const candidate = `#${quote(node.id)}`;
      if (unique(candidate)) return candidate;
    }
    const parts: string[] = [];
    let current: Element | null = node;
    while (current && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === current!.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      const candidate = parts.join(" > ");
      if (unique(candidate)) return candidate;
      current = parent;
    }
    return parts.join(" > ") || node.tagName.toLowerCase();
  };
  const isEditable = (node: Element): boolean => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.isContentEditable) return true;
    const tag = node.tagName.toLowerCase();
    if (tag === "textarea" || tag === "select") return true;
    if (tag === "input") {
      const type = (node.getAttribute("type") ?? "text").toLowerCase();
      return !["button", "submit", "reset", "checkbox", "radio", "file", "image", "hidden", "range", "color"].includes(type);
    }
    return false;
  };
  const describe = (element: Element | null): Record<string, unknown> => {
    if (!(element instanceof Element) || element === document.body || element === document.documentElement) {
      return {};
    }
    const tag = element.tagName.toLowerCase();
    const implicitRole: Record<string, string> = {
      a: "link", button: "button", select: "combobox", textarea: "textbox",
      img: "img", nav: "navigation", main: "main", form: "form",
    };
    const role = element.getAttribute("role")
      ?? (tag === "input"
        ? ((element.getAttribute("type") ?? "text") === "checkbox" ? "checkbox" : "textbox")
        : implicitRole[tag]);
    const labelledBy = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
    const name = element.getAttribute("aria-label")
      ?? (labelledBy || (element as HTMLInputElement).labels?.[0]?.textContent?.trim())
      ?? element.getAttribute("alt")
      ?? element.getAttribute("title")
      ?? (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 160);
    const rect = element.getBoundingClientRect();
    const attributes: Record<string, string> = Object.fromEntries(
      ["id", "class", "data-testid", "name", "type", "aria-label", "title", "contenteditable", "href", "src"]
        .map((key) => [key, element.getAttribute(key)] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== null)
        .map(([key, value]) => [key, value.slice(0, 300)]),
    );
    const editable = isEditable(element);
    if (editable && !attributes.contenteditable && element instanceof HTMLElement && element.isContentEditable) {
      attributes.contenteditable = "true";
    }
    return {
      selector: selectorFor(element),
      tag,
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 500),
      editable,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      documentBounds: {
        x: Math.round(rect.x + window.scrollX), y: Math.round(rect.y + window.scrollY),
        width: Math.round(rect.width), height: Math.round(rect.height),
      },
      attributes,
    };
  };
  if (args.region) {
    const box = args.region;
    const hits: Array<{ node: Element; area: number }> = [];
    for (const node of Array.from(document.querySelectorAll("body *")).slice(0, 10_000)) {
      if (["script", "style", "meta", "link", "noscript"].includes(node.tagName.toLowerCase())) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || rect.right <= box.x || rect.left >= box.x + box.width
        || rect.bottom <= box.y || rect.top >= box.y + box.height) continue;
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
      hits.push({ node, area: rect.width * rect.height });
    }
    // Prefer actual blocks inside the selection over their page-sized ancestors.
    const elements = hits.sort((a, b) => a.area - b.area).slice(0, 12).map(({ node }) => describe(node));
    const text = [...new Set(elements.map((el) => String(el.text || el.name || "")).filter(Boolean))].join("\n").slice(0, 4_000);
    return { elements, text };
  }
  const active = document.activeElement instanceof Element ? document.activeElement : null;
  const hit = typeof args.x === "number" && typeof args.y === "number"
    ? document.elementFromPoint(args.x, args.y)
    : null;
  const focusedEditable = Boolean(
    active
    && active !== document.body
    && active !== document.documentElement
    && isEditable(active),
  );
  // Post-click/press typing state must not fall back to elementFromPoint on a
  // new document after navigation — a coincidental input at the old coordinates
  // is not the focused field.
  const element = args.focusedOnly
    ? (focusedEditable ? active : null)
    : (args.preferFocus && focusedEditable ? active : (hit ?? active));
  return describe(element);
}

// ---------------------------------------------------------------------------
// In-page helpers. Each must stay self-contained: it is serialised with
// toString() and run inside the page.
// ---------------------------------------------------------------------------

function pageFindByText(a: { text: string; exact?: boolean }): Element | null {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const want = norm(a.text);
  const wantLower = want.toLowerCase();
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "HEAD", "TEMPLATE", "TITLE", "META", "LINK"]);
  const textOf = (el: Element): string => {
    if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type)) return el.value;
    return el.textContent ?? "";
  };
  const matches = (el: Element): boolean => {
    const t = norm(textOf(el));
    return a.exact ? t === want : t.toLowerCase().includes(wantLower);
  };
  if (!document.body) return null;
  const all = [document.body, ...Array.from(document.body.querySelectorAll("*")).slice(0, 20_000)];
  for (const el of all) {
    if (skip.has(el.tagName.toUpperCase())) continue;
    if (!matches(el)) continue;
    // Innermost match only, like getByText.
    if (Array.from(el.children).some((child) => !skip.has(child.tagName.toUpperCase()) && matches(child))) continue;
    return el;
  }
  return null;
}

function pageQuerySelector(a: { selector: string }): Element | null {
  return document.querySelector(a.selector);
}

function pageRectHit(this: Element): { x: number; y: number; width: number; height: number; hit: boolean; visible: boolean } {
  const r = this.getBoundingClientRect();
  const left = Math.max(r.left, 0);
  const top = Math.max(r.top, 0);
  const right = Math.min(r.right, window.innerWidth);
  const bottom = Math.min(r.bottom, window.innerHeight);
  const x = (left + right) / 2;
  const y = (top + bottom) / 2;
  const style = getComputedStyle(this);
  const visible = r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  const top_ = visible && right > left && bottom > top ? document.elementFromPoint(x, y) : null;
  const hit = Boolean(top_ && (top_ === this || this.contains(top_) || top_.contains(this) && (this as HTMLElement).tagName === "LABEL"));
  return { x, y, width: r.width, height: r.height, hit, visible };
}

function pageBox(this: Element): { x: number; y: number; width: number; height: number } {
  const r = this.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function pageFocusSelect(this: HTMLElement): string {
  const tag = this.tagName.toLowerCase();
  if (tag === "input") {
    const type = (this.getAttribute("type") ?? "text").toLowerCase();
    const textual = ["text", "search", "url", "tel", "password", "email", "number", ""];
    if (!textual.includes(type)) throw new Error(`Input of type "${type}" cannot be filled`);
    this.focus();
    (this as HTMLInputElement).select();
    return "input";
  }
  if (tag === "textarea") {
    this.focus();
    (this as HTMLTextAreaElement).select();
    return "textarea";
  }
  if (this.isContentEditable) {
    this.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(this);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return "contenteditable";
  }
  throw new Error("Element is not an <input>, <textarea> or [contenteditable] element");
}

function pageSelectOption(this: Element, a: { value: string }): void {
  if (!(this instanceof HTMLSelectElement)) throw new Error("Element is not a <select> element");
  const option = Array.from(this.options).find((o) => o.value === a.value) ?? Array.from(this.options).find((o) => o.label === a.value);
  if (!option) throw new Error("Did not find some options");
  this.value = option.value;
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
}

function pageInspect(this: Element, a: { selector: string }): JsonObject {
  const element = this;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return {
    selector: a.selector,
    tag: element.tagName.toLowerCase(),
    text: (element.textContent ?? "").trim().slice(0, 500),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    styles: {
      display: style.display,
      position: style.position,
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      margin: style.margin,
      padding: style.padding,
      border: style.border,
      borderRadius: style.borderRadius,
      opacity: style.opacity,
      overflow: style.overflow,
    },
  };
}

function pageSelectorState(a: { selector: string }): { attached: boolean; visible: boolean } {
  const el = document.querySelector(a.selector);
  if (!el) return { attached: false, visible: false };
  const r = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return { attached: true, visible: r.width > 0 && r.height > 0 && style.visibility !== "hidden" };
}

function pageInnerText(a: { selector?: string }): string {
  const root = a.selector ? document.querySelector(a.selector) : document.body;
  return root instanceof HTMLElement ? root.innerText : "";
}

function pageTextRange(a: { a: { x: number; y: number }; b: { x: number; y: number } }): { quote: string; rect?: { x: number; y: number; width: number; height: number } } {
  const caret = (x: number, y: number): Range | null => {
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    if (typeof doc.caretRangeFromPoint === "function") return doc.caretRangeFromPoint(x, y);
    const pos = doc.caretPositionFromPoint?.(x, y);
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  };
  const startRange = caret(a.a.x, a.a.y);
  const endRange = caret(a.b.x, a.b.y);
  if (!startRange || !endRange) return { quote: "" };
  const range = document.createRange();
  try {
    range.setStart(startRange.startContainer, startRange.startOffset);
    range.setEnd(endRange.startContainer, endRange.startOffset);
  } catch {
    return { quote: "" };
  }
  if (range.collapsed) {
    try {
      range.setStart(endRange.startContainer, endRange.startOffset);
      range.setEnd(startRange.startContainer, startRange.startOffset);
    } catch {
      return { quote: "" };
    }
  }
  const quote = range.toString().replace(/\s+/g, " ").trim().slice(0, 4_000);
  const rect = range.getBoundingClientRect();
  return {
    quote,
    ...(quote && rect.width + rect.height > 0
      ? { rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

interface KeyDef { key: string; code: string; vk: number; text?: string }

const NAMED_KEYS: Record<string, KeyDef> = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  Insert: { key: "Insert", code: "Insert", vk: 45 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  Space: { key: " ", code: "Space", vk: 32, text: " " },
  Shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
  Control: { key: "Control", code: "ControlLeft", vk: 17 },
  Alt: { key: "Alt", code: "AltLeft", vk: 18 },
  Meta: { key: "Meta", code: "MetaLeft", vk: 91 },
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`F${i}`] = { key: `F${i}`, code: `F${i}`, vk: 111 + i };

const KEY_ALIASES: Record<string, string> = {
  Return: "Enter", Esc: "Escape", Del: "Delete", Ins: "Insert", Up: "ArrowUp", Down: "ArrowDown",
  Left: "ArrowLeft", Right: "ArrowRight", Ctrl: "Control", Cmd: "Meta", Command: "Meta", Option: "Alt",
  Control: "Control", Space: "Space", " ": "Space",
};

const PUNCTUATION: Record<string, { code: string; vk: number }> = {
  "-": { code: "Minus", vk: 189 }, "=": { code: "Equal", vk: 187 }, ",": { code: "Comma", vk: 188 },
  ".": { code: "Period", vk: 190 }, "/": { code: "Slash", vk: 191 }, ";": { code: "Semicolon", vk: 186 },
  "'": { code: "Quote", vk: 222 }, "[": { code: "BracketLeft", vk: 219 }, "]": { code: "BracketRight", vk: 221 },
  "\\": { code: "Backslash", vk: 220 }, "`": { code: "Backquote", vk: 192 },
};

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const EDIT_COMMANDS: Record<string, string> = {
  a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo", y: "redo",
};

function keyDefinition(name: string, shift: boolean): KeyDef {
  const canonical = KEY_ALIASES[name] ?? name;
  const named = NAMED_KEYS[canonical];
  if (named) return named;
  const chars = [...name];
  if (chars.length !== 1) throw new Error(`Unknown key: "${name}"`);
  const ch = chars[0]!;
  if (/^[a-zA-Z]$/.test(ch)) {
    const upper = ch.toUpperCase();
    const value = shift ? upper : ch === upper ? upper : ch;
    return { key: value, code: `Key${upper}`, vk: upper.charCodeAt(0), text: value };
  }
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), text: ch };
  const punct = PUNCTUATION[ch];
  if (punct) return { key: ch, code: punct.code, vk: punct.vk, text: ch };
  return { key: ch, code: "", vk: 0, text: ch };
}

function parseChord(chord: string): { modifiers: string[]; key: string } {
  const parts: string[] = [];
  let rest = chord;
  while (rest.length > 0) {
    const plus = rest.indexOf("+", 1);
    if (plus === -1) { parts.push(rest); break; }
    parts.push(rest.slice(0, plus));
    rest = rest.slice(plus + 1);
  }
  const key = parts.pop() ?? chord;
  const mac = process.platform === "darwin";
  const modifiers = parts.map((part) => {
    if (part === "ControlOrMeta") return mac ? "Meta" : "Control";
    const canonical = KEY_ALIASES[part] ?? part;
    if (!(canonical in MODIFIER_BITS)) throw new Error(`Unknown modifier: "${part}"`);
    return canonical;
  });
  return { modifiers, key };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const CDP_TIMEOUT_MS = 15_000;
const NAVIGATE_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;
const NETWORK_IDLE_QUIET_MS = 500;
const OBJECT_GROUP = "polyth-native-driver";

const contextClosedError = (): Error =>
  Object.assign(new Error("browser context has closed"), { code: "context-closed" });

const asRecord = (value: unknown): Record<string, any> =>
  (typeof value === "object" && value !== null ? value : {}) as Record<string, any>;

export function createNativeDriver(host: NativeWebViewHost): BrowserDriver {
  return {
    engine: "chromium",
    native: true,
    // The host owns every view and process; nothing here is shared.
    async close() {},
    async open(opts) {
      let blockedNavigation: Error | null = null;
      let notifyBlocked: (error: Error, topLevel: boolean, url: string) => void = () => {};
      const view = await host.create({
        width: opts.width,
        height: opts.height,
        ...(opts.profileDir ? { profileDir: opts.profileDir } : {}),
        guardRequest: async (request) => {
          const topLevel = request.kind === "navigation";
          try {
            if (topLevel) await opts.guardNavigation(request.url);
            else if (opts.guardNetworkEgress) await opts.guardNetworkEgress(request.url);
            else throw new Error("network egress guard unavailable");
            return true;
          } catch (error) {
            notifyBlocked(error instanceof Error ? error : new Error(String(error)), topLevel, request.url);
            return false;
          }
        },
      });
      return buildPage(view, opts, {
        takeBlocked: () => { const e = blockedNavigation; blockedNavigation = null; return e; },
        clearBlocked: () => { blockedNavigation = null; },
        peekBlocked: () => blockedNavigation,
        bind: (handler) => {
          notifyBlocked = (error, topLevel, url) => {
            if (topLevel) blockedNavigation = error;
            handler(error, topLevel, url);
          };
        },
      });
    },
  };
}

interface BlockedChannel {
  takeBlocked(): Error | null;
  clearBlocked(): void;
  peekBlocked(): Error | null;
  bind(handler: (error: Error, topLevel: boolean, url: string) => void): void;
}

async function buildPage(
  view: NativeWebView,
  opts: Parameters<BrowserDriver["open"]>[0],
  blocked: BlockedChannel,
): Promise<DriverPage> {
  const listeners = new Set<(ev: DriverPageEvent) => void>();
  const frameCbs = new Set<(frame: DriverFrame) => void>();
  const unsubs = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pending = new Set<{ reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const wakeups = new Set<() => void>();
  let closed = false;
  let gone = false;
  let screencastOn = false;
  let screencastGeneration = 0;
  let lastTitle = "";
  let lastUrl = "about:blank";
  let viewport = { width: opts.width, height: opts.height };
  let resizedWhileShown = false;
  let shownApply: Promise<void> = Promise.resolve();
  let lastMouse: { x: number; y: number } | null = null;
  const lifecycle = new Map<string, Set<string>>();
  const inflight = new Set<string>();
  let lastNetworkActivity = Date.now();
  let navCount = 0;
  let loadCount = 0;
  /** Main-frame `load` events (Page.loadEventFired). Some hosts send no
   * lifecycle event for a navigation's own loader; this one always comes. */
  let pageLoads = 0;

  const emit = (ev: DriverPageEvent) => { for (const l of [...listeners]) l(ev); };
  const wake = () => { for (const w of [...wakeups]) w(); };

  const isClosedMessage = (error: unknown): boolean =>
    /target (page, context or browser )?(has been )?closed|session closed|detached|no target with given id|not attached|view is gone|websocket is not open/i
      .test(String((error as Error | undefined)?.message ?? error ?? ""));
  const wrapError = (error: unknown): Error => {
    if (closed || gone || isClosedMessage(error)) return contextClosedError();
    return error instanceof Error ? error : new Error(String(error));
  };

  const call = (method: string, params?: Record<string, unknown>, timeoutMs = CDP_TIMEOUT_MS): Promise<any> => {
    if (closed || gone) return Promise.reject(contextClosedError());
    return new Promise((resolve, reject) => {
      const entry = {
        reject,
        timer: setTimeout(() => {
          pending.delete(entry);
          reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      pending.add(entry);
      let sent: Promise<unknown>;
      try { sent = view.cdp.send(method, params); } catch (error) { sent = Promise.reject(error); }
      sent.then((value) => {
        clearTimeout(entry.timer);
        if (pending.delete(entry)) resolve(value);
      }, (error) => {
        clearTimeout(entry.timer);
        if (pending.delete(entry)) reject(wrapError(error));
      });
    });
  };

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms);
    timers.add(timer);
  });

  const ensureOpen = () => { if (closed || gone) throw contextClosedError(); };

  /** Resolves when `check` is true; re-evaluated on every page event. */
  const waitFor = (check: () => boolean, timeoutMs: number, what: string): Promise<void> => new Promise((resolve, reject) => {
    if (closed || gone) { reject(contextClosedError()); return; }
    if (check()) { resolve(); return; }
    let timer: ReturnType<typeof setTimeout>;
    const done = (fn: () => void) => { clearTimeout(timer); timers.delete(timer); wakeups.delete(poke); fn(); };
    const poke = () => {
      if (closed || gone) done(() => reject(contextClosedError()));
      else if (check()) done(resolve);
    };
    timer = setTimeout(() => done(() => reject(new Error(`Timeout ${timeoutMs}ms exceeded waiting for ${what}`))), timeoutMs);
    timers.add(timer);
    wakeups.add(poke);
  });

  // Evaluate a self-contained function in the page's main world.
  const evaluate = async <T>(fn: (...args: any[]) => unknown, arg?: unknown, timeoutMs = CDP_TIMEOUT_MS): Promise<T> => {
    const expression = `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`;
    const result = asRecord(await call("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true, objectGroup: OBJECT_GROUP,
    }, timeoutMs));
    if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed"));
    return result.result?.value as T;
  };

  const evaluateRef = async (fn: (...args: any[]) => unknown, arg: unknown): Promise<string | null> => {
    const expression = `(${fn.toString()})(${JSON.stringify(arg)})`;
    const result = asRecord(await call("Runtime.evaluate", { expression, returnByValue: false, objectGroup: OBJECT_GROUP }));
    if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed"));
    const object = asRecord(result.result);
    return object.subtype === "null" || !object.objectId ? null : String(object.objectId);
  };

  const callOn = async <T>(objectId: string, fn: (...args: any[]) => unknown, arg?: unknown): Promise<T> => {
    const result = asRecord(await call("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: fn.toString(),
      arguments: arg === undefined ? [] : [{ value: arg }],
      returnByValue: true,
      awaitPromise: true,
    }));
    if (result.exceptionDetails) {
      const description = String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "call failed");
      throw new Error(description.replace(/^Error: /, "").split("\n")[0]!);
    }
    return result.result?.value as T;
  };

  const releaseObjects = () => { if (!closed && !gone) void call("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }, 5_000).catch(() => {}); };

  const refreshTitle = async (): Promise<void> => {
    try { lastTitle = String(await evaluate<string>(() => document.title, undefined, 5_000) ?? ""); } catch { /* navigating */ }
  };
  const nav = (): DriverNav => ({ url: lastUrl, title: lastTitle });

  // -- element resolution ---------------------------------------------------

  const normalizeName = (s: string) => s.replace(/\s+/g, " ").trim();

  const resolveRole = async (target: { role: string; name?: string; exact?: boolean }): Promise<string | null> => {
    const doc = asRecord(await call("DOM.getDocument", { depth: 0 }));
    const rootId = doc.root?.backendNodeId;
    if (typeof rootId !== "number") return null;
    const found = asRecord(await call("Accessibility.queryAXTree", { backendNodeId: rootId, role: target.role }));
    const want = target.name === undefined ? undefined : normalizeName(target.name);
    for (const node of (found.nodes ?? []) as Array<Record<string, any>>) {
      if (node.ignored || typeof node.backendDOMNodeId !== "number") continue;
      if (want !== undefined) {
        const name = normalizeName(String(node.name?.value ?? ""));
        const ok = target.exact ? name === want : name.toLowerCase().includes(want.toLowerCase());
        if (!ok) continue;
      }
      try {
        const resolved = asRecord(await call("DOM.resolveNode", { backendNodeId: node.backendDOMNodeId, objectGroup: OBJECT_GROUP }));
        if (resolved.object?.objectId) return String(resolved.object.objectId);
      } catch { /* node vanished between query and resolve */ }
    }
    return null;
  };

  const resolveOnce = async (target: Exclude<BrowserTarget, { point: unknown }>): Promise<string | null> => {
    if ("selector" in target) return evaluateRef(pageQuerySelector, { selector: target.selector });
    if ("text" in target) return evaluateRef(pageFindByText, { text: target.text, ...(target.exact !== undefined ? { exact: target.exact } : {}) });
    return resolveRole(target);
  };

  const describeTarget = (target: BrowserTarget): string =>
    "selector" in target ? `selector ${target.selector}` : "text" in target ? `text ${JSON.stringify(target.text)}` : "role" in target ? `role ${target.role}` : "point";

  /** Resolve a target to an actionable element: attached, visible, scrolled
   *  into view and not covered. Polls like Playwright's auto-waiting. */
  const actionable = async (target: Exclude<BrowserTarget, { point: unknown }>, needHit: boolean): Promise<{ objectId: string; x: number; y: number }> => {
    const deadline = Date.now() + ACTION_TIMEOUT_MS;
    let reason = "element not found";
    for (;;) {
      ensureOpen();
      const objectId = await resolveOnce(target);
      if (objectId) {
        try { await call("DOM.scrollIntoViewIfNeeded", { objectId }); } catch { /* detached or not scrollable */ }
        const box = await callOn<{ x: number; y: number; hit: boolean; visible: boolean } | undefined>(objectId, pageRectHit).catch(() => undefined);
        if (box?.visible && (box.hit || !needHit)) return { objectId, x: box.x, y: box.y };
        reason = box?.visible ? "element is covered by another element" : "element is not visible";
      }
      if (Date.now() >= deadline) throw new Error(`Timeout ${ACTION_TIMEOUT_MS}ms exceeded: ${reason} (${describeTarget(target)})`);
      await sleep(50);
    }
  };

  const mouseClick = async (x: number, y: number): Promise<void> => {
    lastMouse = { x, y };
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  };

  const focusedMeta = async (): Promise<JsonObject> => {
    try { return await evaluate<JsonObject>(describeHit, { focusedOnly: true }); } catch (error) {
      if (closed || gone) throw contextClosedError();
      return {};
    }
  };

  const pressChord = async (chord: string): Promise<void> => {
    const { modifiers, key } = parseChord(chord);
    let bits = 0;
    const down: KeyDef[] = [];
    for (const modifier of modifiers) {
      const def = keyDefinition(modifier, false);
      bits |= MODIFIER_BITS[modifier]!;
      await call("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: bits, key: def.key, code: def.code, windowsVirtualKeyCode: def.vk });
      down.push(def);
    }
    const shift = (bits & MODIFIER_BITS.Shift!) !== 0;
    const def = keyDefinition(key, shift);
    const text = (bits & (MODIFIER_BITS.Control! | MODIFIER_BITS.Alt! | MODIFIER_BITS.Meta!)) === 0 ? def.text : undefined;
    const command = (bits & (MODIFIER_BITS.Control! | MODIFIER_BITS.Meta!)) !== 0 && !shift && def.key.length === 1
      ? EDIT_COMMANDS[def.key.toLowerCase()] : undefined;
    const base = { modifiers: bits, key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk };
    await call("Input.dispatchKeyEvent", {
      ...base,
      type: text ? "keyDown" : "rawKeyDown",
      ...(text ? { text, unmodifiedText: text } : {}),
      ...(command ? { commands: [command] } : {}),
    });
    await call("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    for (const modifier of modifiers.reverse()) {
      bits &= ~MODIFIER_BITS[modifier]!;
      const m = keyDefinition(modifier, false);
      await call("Input.dispatchKeyEvent", { type: "keyUp", modifiers: bits, key: m.key, code: m.code, windowsVirtualKeyCode: m.vk });
    }
  };

  // -- navigation -----------------------------------------------------------

  const waitLoad = async (loaderId: string, loadsBefore: number): Promise<void> => {
    const loaded = () => lifecycle.get(loaderId)?.has("load") === true
      || pageLoads > loadsBefore
      || blocked.peekBlocked() !== null;
    try {
      await waitFor(loaded, NAVIGATE_TIMEOUT_MS, "page load");
    } catch (error) {
      // A page that never finishes `load` is usable once the DOM is parsed.
      if (lifecycle.get(loaderId)?.has("DOMContentLoaded")) return;
      throw error;
    }
  };

  const afterNavigation = async (): Promise<DriverNav> => {
    const failure = blocked.takeBlocked();
    if (failure) throw failure;
    await refreshTitle();
    return nav();
  };

  const historyNavigate = async (delta: -1 | 1): Promise<DriverNav> => {
    const history = asRecord(await call("Page.getNavigationHistory"));
    const entries = (history.entries ?? []) as Array<{ id: number }>;
    const index = typeof history.currentIndex === "number" ? history.currentIndex : -1;
    const entry = entries[index + delta];
    if (entry) {
      const before = navCount;
      await call("Page.navigateToHistoryEntry", { entryId: entry.id });
      await waitFor(() => navCount > before, ACTION_TIMEOUT_MS, "history navigation").catch((error) => {
        if (closed || gone) throw error;
      });
      const loads = loadCount;
      await waitFor(() => loadCount > loads, 3_000, "page load").catch(() => {});
    }
    await refreshTitle();
    return nav();
  };

  // -- event wiring ---------------------------------------------------------

  const stopScreencastInternal = async (): Promise<void> => {
    screencastOn = false;
    screencastGeneration++;
    if (!closed && !gone) await call("Page.stopScreencast", undefined, 5_000).catch(() => {});
  };

  const markGone = (message: string) => {
    if (gone) return;
    gone = true;
    emit({ kind: "crash", message });
    for (const entry of [...pending]) { clearTimeout(entry.timer); entry.reject(contextClosedError()); }
    pending.clear();
    wake();
  };

  const onCdpEvent = (method: string, raw: unknown): void => {
    const params = asRecord(raw);
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const text = ((params.args ?? []) as Array<Record<string, any>>)
          .map((a) => a.value !== undefined ? String(a.value) : String(a.description ?? a.type ?? ""))
          .join(" ");
        emit({ kind: "console", level: String(params.type ?? "log"), message: text });
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = asRecord(params.exceptionDetails);
        emit({ kind: "console", level: "error", message: String(d.exception?.description ?? d.text ?? "uncaught exception") });
        break;
      }
      case "Page.frameNavigated": {
        const frame = asRecord(params.frame);
        if (!frame.parentId) {
          lastUrl = String(frame.url ?? lastUrl) + (frame.urlFragment ? String(frame.urlFragment) : "");
          navCount++;
          emit({ kind: "navigation", url: redactUrl(lastUrl) });
          wake();
        }
        break;
      }
      case "Page.navigatedWithinDocument":
        if (typeof params.url === "string") {
          lastUrl = params.url;
          navCount++;
          emit({ kind: "navigation", url: redactUrl(lastUrl) });
          wake();
        }
        break;
      case "Page.loadEventFired":
        pageLoads++;
        wake();
        break;
      case "Page.lifecycleEvent": {
        const loaderId = String(params.loaderId ?? "");
        if (!loaderId) break;
        let names = lifecycle.get(loaderId);
        if (!names) {
          names = new Set();
          lifecycle.set(loaderId, names);
          if (lifecycle.size > 64) lifecycle.delete(lifecycle.keys().next().value as string);
        }
        names.add(String(params.name));
        if (params.name === "load") loadCount++;
        wake();
        break;
      }
      case "Page.javascriptDialogOpening":
        // Playwright dismisses dialogs by default; do the same so the page
        // never blocks on a prompt nobody can answer.
        void call("Page.handleJavaScriptDialog", { accept: false }, 5_000).catch(() => {});
        break;
      case "Page.screencastFrame": {
        const generation = screencastGeneration;
        void call("Page.screencastFrameAck", { sessionId: params.sessionId }, 5_000).catch(() => {});
        if (!screencastOn || generation !== screencastGeneration || typeof params.data !== "string") break;
        const meta = asRecord(params.metadata);
        for (const cb of [...frameCbs]) cb({
          data: new Uint8Array(Buffer.from(params.data, "base64")),
          mime: "image/jpeg",
          ...(meta.deviceWidth ? { width: Number(meta.deviceWidth) } : {}),
          ...(meta.deviceHeight ? { height: Number(meta.deviceHeight) } : {}),
        });
        break;
      }
      case "Network.requestWillBeSent":
        inflight.add(String(params.requestId));
        lastNetworkActivity = Date.now();
        break;
      case "Network.loadingFinished":
      case "Network.loadingFailed":
        inflight.delete(String(params.requestId));
        lastNetworkActivity = Date.now();
        wake();
        break;
      case "Inspector.targetCrashed":
        markGone("page crashed");
        break;
      default:
        break;
    }
  };

  blocked.bind((error, topLevel, url) => {
    emit({ kind: topLevel ? "navigation" : "network", url: redactUrl(url), message: `blocked: ${String(error.message)}` });
    wake();
  });

  unsubs.add(view.cdp.onEvent(onCdpEvent));
  unsubs.add(view.onDownloadBlocked((url) => emit({ kind: "download-blocked", url: redactUrl(url), message: "downloads are blocked" })));
  // A refused window.open / target=_blank: like chromium.ts, report it and send
  // the main page there when it is an http(s) URL (the host's guard decides).
  unsubs.add(view.onWindowOpen((url) => {
    emit({ kind: "popup-blocked", url: redactUrl(url), message: "popups are blocked" });
    if (!/^https?:\/\//i.test(url) || closed || gone) return;
    void call("Page.navigate", { url }, NAVIGATE_TIMEOUT_MS).then(() => refreshTitle(), () => {});
  }));
  unsubs.add(view.onGone((reason: NativeWebViewGoneReason) => {
    markGone(reason === "crashed" ? "page crashed" : `page gone: ${reason}`);
  }));

  // -- metrics --------------------------------------------------------------

  // The host sizes the view: the window that shows it, or the parked size
  // while none does. The page never emulates a size or a pixel ratio, so it
  // always paints at the screen's real ratio (an emulated ratio of 1 drew a
  // shown page at half size on a ratio-2 screen).
  const applyMetrics = async (): Promise<void> => {
    if (closed || gone || view.shown()) return;
    view.setParkedSize(viewport.width, viewport.height);
    // The new bounds reach the page a moment later; wait so the next
    // screenshot or observation sees the size that was asked for.
    const deadline = Date.now() + 1_500;
    while (!closed && !gone && !view.shown() && Date.now() < deadline) {
      const v = await evaluate<{ w: number; h: number }>(() => ({ w: window.innerWidth, h: window.innerHeight }), undefined, 1_000)
        .catch(() => null);
      if (!v || (v.w === viewport.width && v.h === viewport.height)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const colorSchemeParams = (scheme: BrowserColorScheme) => ({
    features: [{ name: "prefers-color-scheme", value: scheme === "no-preference" ? "" : scheme }],
  });

  unsubs.add(view.onShownChange((shown) => {
    shownApply = (async () => {
      // Stepping back (a menu over the stage, the panel closed) keeps the size
      // the window gave the page: the host parks it at that size, so adopt it
      // rather than reflow the page back to an older one.
      if (shown) resizedWhileShown = false;
      else if (!resizedWhileShown) {
        try {
          const v = await evaluate<{ w: number; h: number }>(() => ({ w: window.innerWidth, h: window.innerHeight }), undefined, 3_000);
          if (v.w > 0 && v.h > 0) viewport = { width: v.w, height: v.h };
        } catch { /* keep the last known size */ }
      }
      await applyMetrics();
    })().catch(() => {});
  }));

  const driverPage: DriverPage = {
    nativeViewId: view.id,
    onNativeShown(cb) {
      const listener = (shown: boolean) => {
        void (async () => {
          await shownApply;
          if (closed) return;
          let size: { width?: number; height?: number } = {};
          if (shown) {
            // The window's bounds reach the page a moment after it is shown:
            // report the size once two reads agree.
            let last: { w: number; h: number } | null = null;
            for (let i = 0; i < 10 && !closed; i++) {
              const v = await evaluate<{ w: number; h: number }>(() => ({ w: window.innerWidth, h: window.innerHeight }), undefined, 1_000)
                .catch(() => null);
              if (!v) break;
              if (last && last.w === v.w && last.h === v.h) break;
              last = v;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            if (last) size = { width: last.w, height: last.h };
          }
          if (!closed) cb({ shown, ...size });
        })();
      };
      const off = view.onShownChange(listener);
      const dispose = () => { off(); unsubs.delete(dispose); };
      unsubs.add(dispose);
      return dispose;
    },
    async goto(url) {
      blocked.clearBlocked();
      try {
        const loadsBefore = pageLoads;
        const result = asRecord(await call("Page.navigate", { url }, NAVIGATE_TIMEOUT_MS));
        const failure = blocked.peekBlocked();
        if (failure) { blocked.clearBlocked(); throw failure; }
        if (typeof result.errorText === "string" && result.errorText) throw new Error(result.errorText);
        if (typeof result.loaderId === "string") await waitLoad(result.loaderId, loadsBefore);
        return await afterNavigation();
      } catch (error) {
        const failure = blocked.takeBlocked();
        if (failure) throw failure;
        throw wrapError(error);
      }
    },
    async back() {
      try { return await historyNavigate(-1); } catch (error) { throw wrapError(error); }
    },
    async forward() {
      try { return await historyNavigate(1); } catch (error) { throw wrapError(error); }
    },
    async reload() {
      try {
        const before = loadCount;
        await call("Page.reload", undefined, NAVIGATE_TIMEOUT_MS);
        await waitFor(() => loadCount > before, NAVIGATE_TIMEOUT_MS, "page load");
        return await afterNavigation();
      } catch (error) {
        throw wrapError(error);
      }
    },
    async stop() {
      await call("Page.stopLoading", undefined, 5_000).catch(() => {});
    },
    async click(target) {
      try {
        if ("point" in target) await mouseClick(target.point.x, target.point.y);
        else {
          const at = await actionable(target, true);
          await mouseClick(at.x, at.y);
          releaseObjects();
        }
        await refreshTitle();
        return await focusedMeta();
      } catch (error) {
        throw wrapError(error);
      }
    },
    async point(point) {
      try { return await evaluate<JsonObject>(describeHit, { x: point.x, y: point.y }); } catch (error) { throw wrapError(error); }
    },
    async type(target, text, submit) {
      try {
        if ("point" in target) {
          await mouseClick(target.point.x, target.point.y);
          if (text) await call("Input.insertText", { text });
        } else {
          const at = await actionable(target, false);
          await callOn(at.objectId, pageFocusSelect);
          if (text) await call("Input.insertText", { text });
          else await pressChord("Backspace");
          releaseObjects();
        }
        if (submit) await pressChord("Enter");
        await refreshTitle();
      } catch (error) {
        throw wrapError(error);
      }
    },
    async press(key) {
      try {
        await pressChord(key);
        return await focusedMeta();
      } catch (error) {
        throw wrapError(error);
      }
    },
    async textRange(start, end) {
      try { return await evaluate(pageTextRange, { a: start, b: end }); } catch (error) { throw wrapError(error); }
    },
    async scroll(x, y, target) {
      try {
        if (target && !("point" in target)) {
          await actionable(target, false);
          releaseObjects();
          return;
        }
        const origin = lastMouse ?? { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) };
        await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: origin.x, y: origin.y, deltaX: x, deltaY: y });
        // Let the compositor apply the wheel before the next read.
        await evaluate(() => new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 150);
          requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); resolve(); }));
        }), undefined, 3_000).catch(() => {});
      } catch (error) {
        throw wrapError(error);
      }
    },
    async select(target, value) {
      try {
        if ("point" in target) return;
        const at = await actionable(target, false);
        await callOn(at.objectId, pageSelectOption, { value });
        releaseObjects();
      } catch (error) {
        throw wrapError(error);
      }
    },
    async wait(condition, value, timeoutMs) {
      try {
        const timeout = timeoutMs ?? 10_000;
        if (condition === "network-idle") {
          const deadline = Date.now() + timeout;
          for (;;) {
            ensureOpen();
            if (inflight.size === 0 && Date.now() - lastNetworkActivity >= NETWORK_IDLE_QUIET_MS) return;
            if (Date.now() >= deadline) throw new Error(`Timeout ${timeout}ms exceeded.`);
            await sleep(50);
          }
        } else if (condition === "selector" && value) {
          const deadline = Date.now() + timeout;
          for (;;) {
            ensureOpen();
            const state = await evaluate<{ attached: boolean; visible: boolean }>(pageSelectorState, { selector: value });
            if (state.visible) return;
            if (Date.now() >= deadline) throw new Error(`Timeout ${timeout}ms exceeded waiting for selector "${value}"`);
            await sleep(50);
          }
        }
      } catch (error) {
        throw wrapError(error);
      }
    },
    async resize(next) {
      viewport = { width: next.width, height: next.height };
      // Asked for while the window shows the page: applies once it steps back.
      if (view.shown()) resizedWhileShown = true;
      try {
        view.setParkedSize(next.width, next.height);
        // A shown view takes the size of the window that shows it.
        await applyMetrics();
      } catch (error) {
        throw wrapError(error);
      }
    },
    async emulateColorScheme(colorScheme) {
      try { await call("Emulation.setEmulatedMedia", colorSchemeParams(colorScheme)); } catch (error) { throw wrapError(error); }
    },
    async inspect(selector) {
      try {
        const deadline = Date.now() + ACTION_TIMEOUT_MS;
        for (;;) {
          ensureOpen();
          const objectId = await evaluateRef(pageQuerySelector, { selector });
          if (objectId) {
            const out = await callOn<JsonObject>(objectId, pageInspect, { selector });
            releaseObjects();
            return out;
          }
          if (Date.now() >= deadline) throw new Error(`Timeout ${ACTION_TIMEOUT_MS}ms exceeded waiting for selector "${selector}"`);
          await sleep(50);
        }
      } catch (error) {
        throw wrapError(error);
      }
    },
    async targetRect(target) {
      try {
        if ("point" in target) return { x: target.point.x, y: target.point.y, width: 1, height: 1 };
        const objectId = await resolveOnce(target);
        if (!objectId) return null;
        const box = await callOn<{ x: number; y: number; width: number; height: number }>(objectId, pageBox);
        releaseObjects();
        if (box.width <= 0 && box.height <= 0) return null;
        return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
      } catch (error) {
        throw wrapError(error);
      }
    },
    // The host copies the page: DevTools' screenshot waits for a new frame,
    // which a parked page that does not change never draws (it hung page
    // creation for 20 s). A page that has not painted yet gets a moment.
    screenshot: () => captureWithRetry(),
    screenshotClip: (clip) => captureWithRetry(clip),
    async startScreencast(options) {
      if (screencastOn) await stopScreencastInternal();
      screencastOn = true;
      const generation = ++screencastGeneration;
      try {
        await call("Page.startScreencast", {
          format: "jpeg", quality: options.quality, maxWidth: options.maxWidth, maxHeight: options.maxHeight, everyNthFrame: 1,
        });
      } catch (error) {
        if (generation === screencastGeneration) screencastOn = false;
        throw wrapError(error);
      }
    },
    async stopScreencast() {
      await stopScreencastInternal();
    },
    onFrame(cb) {
      frameCbs.add(cb);
      return () => { frameCbs.delete(cb); };
    },
    async queryRegion(region) {
      try {
        return await evaluate<{ elements: import("@polyth/contracts").BrowserContextElementSummary[]; text: string }>(describeHit, { region });
      } catch (error) {
        throw wrapError(error);
      }
    },
    async observe(selector) {
      try {
        ensureOpen();
        await refreshTitle();
        // innerText excludes input values, so passwords cannot leak this way.
        const text = await evaluate<string>(pageInnerText, selector ? { selector } : {}).catch(() => "");
        let digest = "";
        try { digest = await accessibilityDigest(selector); } catch { /* AX unavailable */ }
        return { url: lastUrl, title: lastTitle, text, accessibilityDigest: digest.slice(0, 4000) };
      } catch (error) {
        throw wrapError(error);
      }
    },
    current: nav,
    onEvent(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    async close() {
      if (closed) return;
      const wasGone = gone;
      if (!wasGone) await stopScreencastInternal().catch(() => {});
      closed = true;
      listeners.clear();
      frameCbs.clear();
      for (const off of [...unsubs]) { try { off(); } catch { /* already gone */ } }
      unsubs.clear();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const entry of [...pending]) { clearTimeout(entry.timer); entry.reject(contextClosedError()); }
      pending.clear();
      wake();
      wakeups.clear();
      await view.close().catch(() => {});
    },
  };

  /** Role/name outline from the AX tree. Never reads `value` and never descends
   *  into text-entry controls, so typed or password text cannot appear. */
  const captureWithRetry = async (clip?: { x: number; y: number; width: number; height: number }): Promise<{ data: Uint8Array; mime: string }> => {
    const deadline = Date.now() + 2_000;
    for (;;) {
      if (closed || gone) throw contextClosedError();
      try {
        return await view.capture(clip);
      } catch (error) {
        if (closed || gone || Date.now() >= deadline) throw wrapError(error);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };

  const accessibilityDigest = async (selector?: string): Promise<string> => {
    const tree = asRecord(await call("Accessibility.getFullAXTree"));
    const nodes = (tree.nodes ?? []) as Array<Record<string, any>>;
    const byId = new Map<string, Record<string, any>>();
    for (const node of nodes) byId.set(String(node.nodeId), node);
    let rootNode: Record<string, any> | undefined = nodes[0];
    if (selector) {
      const objectId = await evaluateRef(pageQuerySelector, { selector });
      if (!objectId) return "";
      const described = asRecord(await call("DOM.describeNode", { objectId }));
      releaseObjects();
      rootNode = nodes.find((n) => n.backendDOMNodeId === described.node?.backendNodeId);
    }
    if (!rootNode) return "";
    const inputRoles = new Set(["textbox", "searchbox", "combobox", "spinbutton", "textField"]);
    const hidden = new Set(["generic", "none", "presentation", "InlineTextBox", "LineBreak", "ignored"]);
    const lines: string[] = [];
    let size = 0;
    const walk = (node: Record<string, any>, depth: number): void => {
      if (size > 4_000 || depth > 40) return;
      const role = String(node.role?.value ?? "");
      let nextDepth = depth;
      if (!node.ignored && !hidden.has(role)) {
        const name = normalizeName(String(node.name?.value ?? "")).slice(0, 200);
        const label = role === "RootWebArea" ? "document" : role === "StaticText" ? "text" : role;
        const line = `${"  ".repeat(depth)}- ${label}${name ? ` ${JSON.stringify(name)}` : ""}`;
        lines.push(line);
        size += line.length + 1;
        nextDepth = depth + 1;
        if (inputRoles.has(role)) return;
      }
      for (const childId of (node.childIds ?? []) as string[]) {
        const child = byId.get(String(childId));
        if (child) walk(child, nextDepth);
      }
    };
    walk(rootNode, 0);
    return lines.join("\n");
  };

  try {
    await call("Page.enable");
    await call("Runtime.enable");
    await call("Network.enable", { maxTotalBufferSize: 100_000, maxResourceBufferSize: 100_000 });
    // The page's requests never answer from a service worker: each one goes
    // to the network, through the host's request guard.
    await call("Network.setBypassServiceWorker", { bypass: true });
    await call("Page.setLifecycleEventsEnabled", { enabled: true });
    await call("Emulation.setFocusEmulationEnabled", { enabled: true });
    await call("Emulation.setEmulatedMedia", colorSchemeParams(opts.colorScheme));
    await call("Emulation.clearDeviceMetricsOverride");
    await applyMetrics();
    const tree = asRecord(await call("Page.getFrameTree"));
    if (typeof tree.frameTree?.frame?.url === "string") lastUrl = tree.frameTree.frame.url;
  } catch (error) {
    await driverPage.close().catch(() => {});
    throw error;
  }
  return driverPage;
}
