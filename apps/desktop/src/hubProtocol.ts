import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const MIME: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

/**
 * The server list runs the shipped shell with connection authority, so its
 * document allows no script but this build's: its own files and the inline
 * scripts of its own index.html, by hash. It talks to nothing over the network;
 * the window reaches other servers only through the main process.
 */
export function hubContentSecurityPolicy(indexHtml: string): string {
  const hashes = new Set<string>();
  for (const match of indexHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)) {
    const body = match[1] ?? "";
    if (!body.trim()) continue;
    // HTML parsing normalizes CRLF and bare CR before CSP checks script text.
    hashes.add(`'sha256-${createHash("sha256").update(body.replace(/\r\n?/g, "\n")).digest("base64")}'`);
  }
  return [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    `script-src ${["'self'", ...hashes].join(" ")}`,
    "connect-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** A file of the shell for this request path, or null. There are no routes on
 *  this origin, so nothing falls back to index.html. */
export async function resolveHubFile(webDist: string, pathname: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const parts = decoded.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) return null;
  const relative = parts.length > 0 ? parts : ["index.html"];
  const root = resolve(webDist);
  try {
    const file = await realpath(join(root, ...relative));
    const realRoot = await realpath(root);
    return file.startsWith(`${realRoot}${sep}`) ? file : null;
  } catch {
    return null;
  }
}

/** Answers one request on the list's origin from the shipped shell. */
export async function hubResponse(webDist: string, request: { url: string; method: string }): Promise<Response> {
  const notFound = (): Response => new Response(null, { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return notFound();
  }
  if (url.host !== "hub") return notFound();
  const file = await resolveHubFile(webDist, url.pathname);
  if (!file) return notFound();
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return notFound();
  }
  const headers: Record<string, string> = {
    "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (extname(file).toLowerCase() === ".html") {
    headers["Content-Security-Policy"] = hubContentSecurityPolicy(body.toString("utf8"));
  }
  return new Response(request.method === "HEAD" ? null : new Uint8Array(body), { status: 200, headers });
}
