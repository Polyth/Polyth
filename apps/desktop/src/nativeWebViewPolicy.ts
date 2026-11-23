// Pure rules of the native web view host (nativeWebViews.ts), kept free of
// Electron so they are tested under plain Node.
import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface NativeWebViewRect { x: number; y: number; width: number; height: number }

export const MAX_SIDE = 8192;
/** Schemes a page may load for subresources without asking the consumer. */
const LOCAL_SUBRESOURCE_SCHEMES = new Set(["about:", "data:", "blob:"]);
const GUARDED_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
/** The one permission a page gets: writing (never reading) the clipboard. */
export const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

const invalid = (): Error => Object.assign(new Error("invalid-request"), { code: "invalid-request" });

export function parseViewRect(value: unknown): NativeWebViewRect | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const rect = value as Record<string, unknown>;
  const read = (key: string, min: number): number => {
    const n = rect[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < min || Math.abs(n) > MAX_SIDE) throw invalid();
    return Math.round(n);
  };
  return { x: read("x", -MAX_SIDE), y: read("y", -MAX_SIDE), width: read("width", 1), height: read("height", 1) };
}

/** An absolute directory inside `dataDir`, created, with no symlink leading out. */
export function confinedProfileDir(dataDir: string, requested: string): string {
  if (!isAbsolute(requested)) throw invalid();
  const root = resolve(dataDir);
  const dir = resolve(requested);
  const inside = (base: string, candidate: string) => {
    const rel = relative(base, candidate);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (!inside(root, dir)) throw invalid();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!inside(realpathSync(root), realpathSync(dir))) throw invalid();
  return dir;
}

/** What the page may load before (and regardless of) the consumer's guard. */
export function schemeVerdict(url: string, mainFrame: boolean): "guard" | "allow" | "deny" {
  let protocol: string;
  try { protocol = new URL(url).protocol; } catch { return "deny"; }
  if (GUARDED_SCHEMES.has(protocol)) return "guard";
  if (protocol === "about:" && url === "about:blank") return "allow";
  if (!mainFrame && LOCAL_SUBRESOURCE_SCHEMES.has(protocol)) return "allow";
  // devtools: is DevTools' own front end, opened by the person on their page.
  if (protocol === "devtools:") return "allow";
  return "deny";
}

/** A browser's user agent: an embedded-app token makes sign-in pages refuse. */
export function plainChromeUserAgent(base: string, appName: string): string {
  const name = appName.replace(/[^\w.-]/g, "");
  let agent = base.replace(/\s+Electron\/\S+/g, "").replace(/\s+Polyth\S*\/\S+/gi, "");
  if (name) agent = agent.replace(new RegExp(`\\s+${name}\\/\\S+`, "gi"), "");
  return agent.replace(/\s{2,}/g, " ").trim();
}

