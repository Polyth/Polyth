// The ```page fence: a self-contained HTML page an agent shows inline. Pure
// and browser-safe (no DOM): fence parsing, the sandboxed document builder,
// the postMessage protocol and the download name. The widget mounts the
// result in `<iframe sandbox="allow-scripts" srcdoc>`; nothing here grants a
// page more than that.
import { projectFilePath } from "./parse.ts";

export const PAGE_CHANNEL = "polyth-page-v1";
/** The only sandbox token. Never same-origin, navigation, popups, forms or modals. */
export const PAGE_SANDBOX = "allow-scripts";
export const PAGE_MAX_INLINE_BYTES = 256 * 1024;
export const PAGE_MAX_FILE_BYTES = 512 * 1024;
export const PAGE_MIN_HEIGHT = 80;
export const PAGE_MAX_HEIGHT = 1200;
export const PAGE_MAX_SEND = 500;
export const PAGE_MAX_TITLE = 120;
/** `polyth.storage`: a small string map a page keeps. Enforced again by
 *  whoever persists it; in a chat nothing does, and the map lasts one load. */
export const PAGE_STORAGE_MAX_KEYS = 200;
export const PAGE_STORAGE_MAX_KEY = 128;
export const PAGE_STORAGE_MAX_VALUE_BYTES = 64 * 1024;
export const PAGE_STORAGE_MAX_BYTES = 256 * 1024;

export const PAGE_CSP = [
  "default-src 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Goes before ANY agent content, so the policy is in force before the first
 *  agent byte is parsed. A later policy in the page can only tighten it. */
export const PAGE_PREAMBLE =
  `<!doctype html><meta charset=utf-8><meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}"><meta name=referrer content=no-referrer>`;

export interface PageTheme {
  scheme: "light" | "dark";
  bg: string;
  fg: string;
  muted: string;
  accent: string;
  border: string;
  font: string;
  radius: string;
}

export const DEFAULT_PAGE_THEME: PageTheme = {
  scheme: "dark",
  bg: "#0f1115",
  fg: "#e8eaf0",
  muted: "#8f96a8",
  accent: "#7aa2f7",
  border: "#2c3240",
  font: "ui-sans-serif, system-ui, sans-serif",
  radius: "8px",
};

// A token value is a colour, a font list or a length; nothing that could
// close the style element or the rule.
const cssValue = (value: string, fallback: string): string => {
  const clean = value.replace(/[<>{};\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 240);
  return clean || fallback;
};

/** Theme variables plus a minimal base the page can override (it comes first). */
export function pageThemeCss(theme: PageTheme): string {
  const d = DEFAULT_PAGE_THEME;
  const scheme = theme.scheme === "light" ? "light" : "dark";
  return `:root{color-scheme:${scheme};--polyth-bg:${cssValue(theme.bg, d.bg)};--polyth-fg:${cssValue(theme.fg, d.fg)};`
    + `--polyth-muted:${cssValue(theme.muted, d.muted)};--polyth-accent:${cssValue(theme.accent, d.accent)};`
    + `--polyth-border:${cssValue(theme.border, d.border)};--polyth-font:${cssValue(theme.font, d.font)};`
    + `--polyth-radius:${cssValue(theme.radius, d.radius)}}`
    + `html,body{background:var(--polyth-bg);color:var(--polyth-fg)}`
    + `body{margin:0;padding:12px;font:15px/1.5 var(--polyth-font)}`;
}

// Runs before the agent's content. Announces each document it starts (the
// host's navigation check), reports height, relays theme updates and
// exposes polyth.send(text), which only ever asks the host to show a choice,
// and polyth.storage, a string map shaped like localStorage (a sandboxed
// frame has none). The map is seeded by the host and every change is posted
// to it; whether it outlives this load is the host's decision (`persistent`).
export interface PageBridgeOptions {
  /** The map the page starts with. */
  storage?: Readonly<Record<string, string>>;
  /** True when the host keeps the map between loads (an installed page). */
  persistent?: boolean;
}

// JSON inside a script element: nothing in it may end the element or a line.
const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

function pageBridge(options: PageBridgeOptions): string {
  return `(function(){var C=${JSON.stringify(PAGE_CHANNEL)},last=-1,S=Object.assign(Object.create(null),JSON.parse(${scriptJson(JSON.stringify(options.storage ?? {}))}));`
    + `function post(m){m.channel=C;parent.postMessage(m,"*")}`
    + `function h(){var v=Math.ceil(document.documentElement.getBoundingClientRect().height);if(v!==last){last=v;post({kind:"height",value:v})}}`
    + `function key(k){k=String(k);if(!k||k.length>${PAGE_STORAGE_MAX_KEY})throw new Error("polyth.storage: invalid key");return k}`
    + `window.polyth={send:function(t){if(typeof t==="string")post({kind:"send",text:t})},storage:{persistent:${options.persistent === true},`
    + `getItem:function(k){k=String(k);return k in S?S[k]:null},`
    + `setItem:function(k,v){k=key(k);v=String(v);if(v.length>${PAGE_STORAGE_MAX_VALUE_BYTES})throw new Error("polyth.storage: value too large");`
    + `if(!(k in S)&&Object.keys(S).length>=${PAGE_STORAGE_MAX_KEYS})throw new Error("polyth.storage: too many keys");S[k]=v;post({kind:"storage",op:"set",key:k,value:v})},`
    + `removeItem:function(k){k=String(k);if(k in S){delete S[k];post({kind:"storage",op:"remove",key:k})}},`
    + `clear:function(){S=Object.create(null);post({kind:"storage",op:"clear"})},`
    + `keys:function(){return Object.keys(S)}}};`
    + `addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d||d.channel!==C||d.kind!=="theme"||typeof d.css!=="string")return;`
    + `var s=document.getElementById("polyth-theme");if(s)s.textContent=d.css});`
    + `post({kind:"ready"});if(window.ResizeObserver)new ResizeObserver(h).observe(document.documentElement);addEventListener("load",h);h()})()`;
}

/** The complete srcdoc. The policy comes first, our theme and bridge next,
 *  the agent's content last and untouched (no head surgery). */
export function buildPageDocument(content: string, theme: PageTheme = DEFAULT_PAGE_THEME, options: PageBridgeOptions = {}): string {
  return `${PAGE_PREAMBLE}<style id="polyth-theme">${pageThemeCss(theme)}</style><script>${pageBridge(options)}</script>${content}`;
}

export const pageByteLength = (text: string): number => new TextEncoder().encode(text).length;

export interface PageFence {
  title: string;
  /** Validated project-relative `.html` path, when the fence names a file. */
  from?: string;
  /** A `from=` value that failed validation. */
  badFrom?: string;
  body: string;
}

const HTML_EXT_RE = /\.html?$/i;
const TITLE_COMMENT_RE = /^\s*<!--\s*title:\s*([^]*?)\s*-->/i;

export const pageFilePath = (value: string | undefined): string | null => projectFilePath(value, HTML_EXT_RE);

const cleanTitle = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, PAGE_MAX_TITLE);

/** The host folds the opening line's extra tokens in as the first line of
 *  `text` (older hosts) and also passes them separately as `info`. When
 *  `info` is defined it is the authoritative opening line: strip exactly the
 *  folded first line from `text` and parse title/`from=` from `info`. Only
 *  without `info` (an older host) fall back to guessing from `text`: HTML
 *  starts with `<`, so a first line that does not is that info line. */
export function parsePageFence(text: string, info?: string): PageFence {
  let infoLine: string;
  let body: string;
  if (info !== undefined) {
    infoLine = info;
    body = info === "" ? text
      : text === info ? ""
      : text.startsWith(`${info}\n`) ? text.slice(info.length + 1)
      : text;
  } else {
    const newline = text.indexOf("\n");
    const first = newline < 0 ? text : text.slice(0, newline);
    const hasInfo = first.trim() !== "" && !first.trimStart().startsWith("<");
    infoLine = hasInfo ? first : "";
    body = hasInfo ? (newline < 0 ? "" : text.slice(newline + 1)) : text;
  }
  let from: string | undefined;
  let badFrom: string | undefined;
  const words: string[] = [];
  for (const word of infoLine.split(/\s+/)) {
    const m = /^from=(.*)$/i.exec(word);
    if (!m) {
      if (word !== "·") words.push(word);
      continue;
    }
    const path = pageFilePath(m[1]);
    if (path) from = path;
    else badFrom = m[1] ?? "";
  }
  const comment = TITLE_COMMENT_RE.exec(body.slice(0, 600));
  const title = cleanTitle(words.join(" ")) || cleanTitle(comment?.[1] ?? "");
  return { title, body, ...(from ? { from } : {}), ...(badFrom !== undefined ? { badFrom } : {}) };
}

export type PageMessage =
  | { kind: "ready" }
  | { kind: "height"; value: number }
  | { kind: "send"; text: string }
  | { kind: "storage"; op: "set"; key: string; value: string }
  | { kind: "storage"; op: "remove"; key: string }
  | { kind: "storage"; op: "clear" };

export const clampPageHeight = (value: number): number =>
  Math.min(PAGE_MAX_HEIGHT, Math.max(PAGE_MIN_HEIGHT, Math.round(value)));

/** Validate a message from the page. The caller has already checked that the
 *  event source is this frame's window. */
export function parsePageMessage(data: unknown): PageMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.channel !== PAGE_CHANNEL) return null;
  if (m.kind === "ready") return { kind: "ready" };
  if (m.kind === "height") {
    return typeof m.value === "number" && Number.isFinite(m.value) ? { kind: "height", value: clampPageHeight(m.value) } : null;
  }
  if (m.kind === "send") {
    if (typeof m.text !== "string") return null;
    const text = m.text.trim();
    return text && text.length <= PAGE_MAX_SEND ? { kind: "send", text } : null;
  }
  if (m.kind === "storage") {
    if (m.op === "clear") return { kind: "storage", op: "clear" };
    if (!pageStorageKey(m.key)) return null;
    if (m.op === "remove") return { kind: "storage", op: "remove", key: m.key };
    if (m.op === "set" && pageStorageValue(m.value)) return { kind: "storage", op: "set", key: m.key, value: m.value };
  }
  return null;
}

export const pageStorageKey = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= PAGE_STORAGE_MAX_KEY;

export const pageStorageValue = (value: unknown): value is string =>
  typeof value === "string" && value.length <= PAGE_STORAGE_MAX_VALUE_BYTES && pageByteLength(value) <= PAGE_STORAGE_MAX_VALUE_BYTES;

/** A stored map as the bridge may be seeded with it: own string entries
 *  within the key, value, count and total limits. Anything else is dropped,
 *  so a damaged file never reaches a page. */
export function cleanPageStorage(raw: unknown): Record<string, string> {
  const clean: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return clean;
  let count = 0;
  let bytes = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!pageStorageKey(key) || !pageStorageValue(value)) continue;
    const size = pageByteLength(key) + pageByteLength(value);
    if (count >= PAGE_STORAGE_MAX_KEYS || bytes + size > PAGE_STORAGE_MAX_BYTES) break;
    clean[key] = value;
    count += 1;
    bytes += size;
  }
  return clean;
}

/** Size of a map against PAGE_STORAGE_MAX_BYTES. */
export const pageStorageBytes = (values: Readonly<Record<string, string>>): number =>
  Object.entries(values).reduce((sum, [key, value]) => sum + pageByteLength(key) + pageByteLength(value), 0);

/** A safe download name from a page title. */
export function pageFileName(title: string): string {
  const stem = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${stem || "page"}.html`;
}
