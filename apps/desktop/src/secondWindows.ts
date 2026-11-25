// Polyth's own second windows (apps/web/src/secondWindow.ts): a page asks for a
// chat or one workspace window in a window of its own with `window.open` on
// its own origin and a `window=chat|pane` role. Everything else a page opens is
// an external link. Pure, so the rule is testable without Electron.
import { HUB_ORIGIN } from "./windowSurface.ts";

export interface SecondWindowRequest {
  /** One window per chat, one pane window: a second request focuses it. */
  key: string;
  url: string;
}

const ROLES = new Set(["chat", "pane"]);

function parse(raw: string): URL | null {
  try { return new URL(raw); } catch { return null; }
}

/** The page at `pageUrl` asks for one of its own second windows; null for
 *  anything else (another origin, the server list, no role). */
export function secondWindowRequest(pageUrl: string, targetUrl: string): SecondWindowRequest | null {
  const page = parse(pageUrl);
  const target = parse(targetUrl);
  if (!page || !target) return null;
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  if (page.origin !== target.origin || page.origin === "null" || page.origin === HUB_ORIGIN) return null;
  if (target.username || target.password) return null;
  const role = target.searchParams.get("window");
  if (!role || !ROLES.has(role)) return null;
  const key = role === "chat"
    ? `${target.origin} chat ${target.searchParams.get("session") ?? target.pathname}`
    : `${target.origin} pane`;
  return { key, url: target.toString() };
}
