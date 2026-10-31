// Transient error toast presentation (visual only). The UI error state keeps a
// single message string and one 7s lifetime; this module derives the compact
// two-level copy and the contextual icon category at the display boundary. It
// never changes what is stored, when the toast appears, or when it hides.

import { errorBodyText } from "@polyth/contracts";
import { tr } from "./i18n/index.ts";

export type UiErrorCategory = "network" | "auth" | "storage" | "server" | "blocked" | "error";

export interface UiErrorPresentation {
  /** Short, dominant heading; empty when the message has no compact label. */
  title: string;
  /** Muted supporting line; empty when the message is a single short line. */
  description: string;
  category: UiErrorCategory;
}

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 240;

// A request that never produced an HTTP response rejects with an engine-specific
// TypeError. The message is the only portable signal: Chromium says "Failed to
// fetch", Firefox "NetworkError when attempting to fetch resource", Android
// WebView "net::ERR_...", and iOS/WKWebView — including the Capacitor shell —
// reports the same rejected fetch/XHR/module request as the bare "Load failed".
// Treating that phrasing as an ordinary error is why a transient link loss on a
// phone surfaced as a cryptic "Load failed" banner rather than a reconnect.
const TRANSPORT_FAILURE_RE = /load failed|failed to fetch|fetch failed|networkerror|network request failed|net::err_[a-z0-9_]+|the network connection was lost|network connection was lost|the internet connection appears to be offline|the request timed out|a server with the specified hostname could not be found/i;

// The whole message is just an engine's phrase for a request that never got an
// answer. It names nothing anyone can act on, so a toast presents it as the
// lost connection it is (callers that use friendlyError already do).
const BARE_TRANSPORT_PHRASE = /^(?:typeerror:\s*)?(?:load failed|failed to fetch|fetch failed|network request failed|networkerror when attempting to fetch resource\.?)$/i;

// A request cancelled by its deadline (or any other abort) rejects with an
// engine-specific DOMException. WebKit — the iOS app included — says "Fetch is
// aborted" whatever the abort reason was, so a stalled read that hit its
// deadline surfaced as the meaningless "Error: Fetch is aborted". Chromium says
// "signal is aborted without reason" / "The operation timed out.", Firefox
// "The operation was aborted.". Deliberate cancellations are silenced by their
// callers; one that reaches the user is a request that never got its answer.
const ABORT_PHRASE = /fetch is aborted|request signal is aborted|signal is aborted without reason|the (?:user|operation) (?:was )?aborted(?: a request)?|this operation was aborted|the operation timed out/i;
const BARE_ABORT_PHRASE = new RegExp(`^(?:(?:abort|timeout)error:\\s*)?(?:${ABORT_PHRASE.source})\\.?$`, "i");

/** True for a request that was aborted or timed out on the client before any
 *  HTTP answer. Kept apart from `isTransportFailure`: a create/send recovery
 *  loop must not retry a cancellation as if the network had dropped it. */
export function isRequestAbort(error: unknown): boolean {
  if (error && typeof error === "object") {
    const name = (error as { name?: unknown }).name;
    if (name === "AbortError" || name === "TimeoutError") return true;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message !== "" && BARE_ABORT_PHRASE.test(message.trim());
}

/** True when a failure describes a transport-level request loss (no HTTP
 *  response), not a typed server rejection. `status: 0` is the app's own
 *  "no HTTP status" sentinel from `httpStatusOf`. */
export function isTransportFailure(error: unknown): boolean {
  if (error && typeof error === "object") {
    const typed = error as { component?: unknown; status?: unknown };
    if (typed.component !== undefined) return typed.component === "client-transport";
    if (typeof typed.status === "number" && typed.status > 0) return false;
  }
  if (typeof error === "object" && error !== null && (error as { status?: unknown }).status === 0) return true;
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  return message !== "" && TRANSPORT_FAILURE_RE.test(message);
}

// Category order matters: the first match wins. Transport symptoms are checked
// before the operation they failed ("cannot connect" is a network problem).
const CATEGORY_MATCHERS: ReadonlyArray<readonly [UiErrorCategory, RegExp]> = [
  ["network", /\b(network|offline|connect(?:ion|ed|ing|s)?|reconnect|fetch failed|econnrefused|econnreset|enotfound|socket hang up|timed? out|timeout|dns|unreachable|50[234])\b/i],
  ["network", TRANSPORT_FAILURE_RE],
  ["network", ABORT_PHRASE],
  ["auth", /\b(unauthori[sz]ed|forbidden|permission|denied|credentials?|passkey|40[13])\b/i],
  ["storage", /\b(disk|storage|quota|enospc|no space|filesystem|read[- ]?only|save|write)\b/i],
  ["server", /\b(server|backend|database|service unavailable|internal error|bad gateway|500)\b/i],
  ["blocked", /\b(unsupported|not supported|not available|unavailable operation|blocked|disabled|insufficient[_\s-]?(?:account[_\s-]?)?funds|quota[_\s-]?exhausted|out of credits|payment required|402)\b/i],
];

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const MAX_ERR_LEN = 160;

function truncate(s: string): string {
  return s.length > MAX_ERR_LEN ? `${s.slice(0, MAX_ERR_LEN - 1).trimEnd()}…` : s;
}

export function parseInnerJsonError(jsonStr: string): string | undefined {
  try {
    const body = JSON.parse(jsonStr) as Record<string, unknown>;
    if (!body || typeof body !== "object") return undefined;
    const err = (body?.error && typeof body.error === "object" ? body.error : undefined) as Record<string, unknown> | undefined;
    const inner = body?.message ?? err?.message ?? body?.error;
    if (typeof inner === "string" && inner.trim() !== "") {
      return inner.trim();
    }
  } catch {}
  return undefined;
}

// API errors look like `HTTP 500 Internal Server Error — {"error":"…"}`,
// `402: {"error":{"message":"…"}}` or `HTTP 504 Gateway Time-out — <html>…`.
// Pull the human part out of the JSON or HTML body; never surface raw markup.
export function shortMessage(raw: string): string {
  const trimmed = raw.trim();
  const braceIndex = trimmed.indexOf("{");
  if (braceIndex >= 0 && trimmed.endsWith("}")) {
    const head = trimmed.slice(0, braceIndex).replace(/[:—–]\s*$/, "").trim();
    const tail = trimmed.slice(braceIndex).trim();
    const inner = parseInnerJsonError(tail);
    if (inner) {
      if (!head) return truncate(inner);
      if (/^(?:HTTP\s*)?\d{3}$/i.test(head)) {
        return truncate(`${inner} (${head.toUpperCase().startsWith("HTTP") ? head : `HTTP ${head}`})`);
      }
      return truncate(`${head} — ${inner}`);
    }
  }
  const dash = trimmed.indexOf("—");
  if (dash >= 0) {
    const head = trimmed.slice(0, dash).trim();
    const tail = trimmed.slice(dash + 1).trim();
    if (tail.startsWith("{")) {
      const inner = parseInnerJsonError(tail);
      if (inner) return truncate(`${head} — ${inner}`);
      return truncate(errorBodyText(head));
    }
    if (head) return truncate(errorBodyText(head));
  }
  return truncate(errorBodyText(trimmed));
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cap(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/** Split "Head: detail" / "Head — detail" only when the head is a compact
 *  label, so a URL or a sentence fragment never becomes a fake title. */
function splitOnSeparator(text: string): { title: string; description: string } {
  for (const separator of [": ", " — ", " – "]) {
    const at = text.indexOf(separator);
    if (at <= 0) continue;
    const head = text.slice(0, at).trim();
    let tail = text.slice(at + separator.length).trim();
    if (!tail || head.length > MAX_TITLE || URL_SCHEME.test(head)) continue;
    if (tail.includes("{") && tail.endsWith("}")) {
      tail = shortMessage(tail);
    }
    if (/^(?:HTTP\s*)?\d{3}$/i.test(head)) {
      return { title: tail, description: head.toUpperCase().startsWith("HTTP") ? head : `HTTP ${head}` };
    }
    return { title: head, description: tail };
  }
  if (text.includes("{") && text.endsWith("}")) {
    return { title: shortMessage(text), description: "" };
  }
  return { title: text, description: "" };
}

export function classifyUiError(message: string): UiErrorCategory {
  for (const [category, matcher] of CATEGORY_MATCHERS) {
    if (matcher.test(message)) return category;
  }
  return "error";
}

export function presentUiError(message: string): UiErrorPresentation {
  // Last-resort guard: an upstream/proxy page that reached the store as raw
  // text still renders as one readable line instead of its markup.
  const safe = errorBodyText(message);
  const normalized = collapse(safe);
  let title = "";
  let description = "";
  if (normalized) {
    const newline = safe.indexOf("\n");
    if (newline >= 0) {
      title = collapse(safe.slice(0, newline));
      description = collapse(safe.slice(newline + 1));
    } else {
      ({ title, description } = splitOnSeparator(normalized));
    }
  }
  const bare = (text: string) => BARE_TRANSPORT_PHRASE.test(text) || BARE_ABORT_PHRASE.test(text);
  if (bare(description)) {
    // "TypeError: Load failed" has no operation to keep as a heading.
    if (/^(?:type|abort|timeout)?error$/i.test(title)) {
      title = tr("settings.polythConnectionLost");
      description = "";
    } else description = tr("settings.polythConnectionLost");
  } else if (!description && bare(title)) title = tr("settings.polythConnectionLost");
  return {
    title: cap(title, MAX_TITLE),
    // Never repeat the heading as the body; an empty body just renders the title.
    description: description && description !== title ? cap(description, MAX_DESCRIPTION) : "",
    category: classifyUiError(normalized),
  };
}
