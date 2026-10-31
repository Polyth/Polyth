// Operator-facing HTTP 500 diagnostics. Log method, pathname, and query
// *names*. Query values are redacted by default — do not guess which keys
// are secrets. Request bodies and headers are never logged.
import { redactSecrets } from "@polyth/plugins";

const decodeQueryPart = (raw: string): string => {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
};

export function collapseLogText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, (ch) => {
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (ch === "\t") return "\\t";
    return `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

export function sanitizeRequestUrl(raw: string | undefined): string {
  const value = raw && raw.trim() ? raw.trim() : "/";
  const cut = value.indexOf("?");
  const path = collapseLogText(redactSecrets(cut < 0 ? value : value.slice(0, cut)));
  if (cut < 0) return path;
  const parts: string[] = [];
  for (const pair of value.slice(cut + 1).split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = collapseLogText(decodeQueryPart(eq < 0 ? pair : pair.slice(0, eq)) || "unnamed");
    parts.push(`${key}=[redacted]`);
  }
  return parts.length > 0 ? `${path}?${parts.join("&")}` : path;
}

export function sanitizeLoggedError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 4; depth++) {
    if (current instanceof Error) {
      parts.push(collapseLogText(redactSecrets(`${current.name}: ${current.message}`)));
      if (depth === 0 && current.stack) {
        parts.push(collapseLogText(redactSecrets(current.stack)));
      }
      current = current.cause;
      continue;
    }
    parts.push(collapseLogText(redactSecrets(String(current))));
    break;
  }
  return parts.join(" <- ");
}

export function logHttp500(method: string, url: string | undefined, err: unknown): void {
  console.error(`[polyth] ${collapseLogText(method)} ${sanitizeRequestUrl(url)} failed: ${sanitizeLoggedError(err)}`);
}
