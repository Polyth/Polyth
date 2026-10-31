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
// exposes polyth.send(text), which only ever asks the host to show a choice.
const BRIDGE = `(function(){var C=${JSON.stringify(PAGE_CHANNEL)},last=-1;`
  + `function post(m){m.channel=C;parent.postMessage(m,"*")}`
  + `function h(){var v=Math.ceil(document.documentElement.getBoundingClientRect().height);if(v!==last){last=v;post({kind:"height",value:v})}}`
  + `window.polyth={send:function(t){if(typeof t==="string")post({kind:"send",text:t})}};`
  + `addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d||d.channel!==C||d.kind!=="theme"||typeof d.css!=="string")return;`
  + `var s=document.getElementById("polyth-theme");if(s)s.textContent=d.css});`
  + `post({kind:"ready"});if(window.ResizeObserver)new ResizeObserver(h).observe(document.documentElement);addEventListener("load",h);h()})()`;

/** The complete srcdoc. The policy comes first, our theme and bridge next,
 *  the agent's content last and untouched (no head surgery). */
export function buildPageDocument(content: string, theme: PageTheme = DEFAULT_PAGE_THEME): string {
  return `${PAGE_PREAMBLE}<style id="polyth-theme">${pageThemeCss(theme)}</style><script>${BRIDGE}</script>${content}`;
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
  | { kind: "send"; text: string };

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
  return null;
}

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
