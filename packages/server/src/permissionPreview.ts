// Server-side permission previews (WP15). Generated with secret redaction
// BEFORE the permission/requested event is appended, so nothing sensitive
// ever reaches the durable log or the UI.
import type { JsonObject, PermissionPreview, PermissionScope } from "@polyth/contracts";

export const PERMISSION_ALLOWED_SCOPES: PermissionScope[] = ["once", "session", "project"];

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk|ghp|gho|ghu|ghs|xoxb|xoxp|AKIA)[A-Za-z0-9_-]{12,}\b/g,
  // whole header line: "authorization: Bearer x" must not leave the token behind
  /\b(authorization|proxy-authorization)\s*[:=][^\n]+/gi,
  /\b(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S+/gi,
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWTs
];

/** Names whose metadata values are dropped entirely, not just masked. */
const SENSITIVE_KEYS = /token|secret|password|credential|apikey|api_key|auth/i;

export function redactPreviewText(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, "[redacted]");
  return out;
}

const HIGH_RISK = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
  /\bsudo\b/, /\bmkfs\b/, /\bdd\s+if=/i, /\bchmod\s+777\b/,
  /curl[^|]*\|\s*(ba)?sh/i, /wget[^|]*\|\s*(ba)?sh/i,
  /\bgit\s+push\s+.*--force\b/i, /\bdrop\s+table\b/i, /\bdel(tree)?\s+\/s\b/i,
  /\.env\b/, /id_rsa/, /\.ssh\//, /secrets?\./i,
];

const LOW_RISK_PERMISSIONS = /^(read|list|glob|grep|ls)$/i;

function riskOf(permission: string, patterns: string[]): "low" | "medium" | "high" {
  const joined = patterns.join("\n");
  if (HIGH_RISK.some((r) => r.test(joined))) return "high";
  if (LOW_RISK_PERMISSIONS.test(permission)) return "low";
  return "medium";
}

const MAX_LINES = 6;
const MAX_LINE_CHARS = 200;

const clip = (s: string): string => (s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS)}…` : s);

/** Build the redacted, bounded preview shown on permission banners/toasts. */
export function buildPermissionPreview(input: {
  permission: string;
  patterns: string[];
  metadata?: JsonObject;
  tool?: string;
}): PermissionPreview {
  const lines: string[] = [];
  for (const p of input.patterns) {
    if (lines.length >= MAX_LINES) break;
    lines.push(clip(redactPreviewText(p)));
  }
  if (input.metadata) {
    for (const [key, value] of Object.entries(input.metadata)) {
      if (lines.length >= MAX_LINES) break;
      if (SENSITIVE_KEYS.test(key)) continue; // drop, never mask-and-show
      if (value === null || typeof value === "object") continue;
      lines.push(clip(`${key}: ${redactPreviewText(String(value))}`));
    }
  }
  const title = input.tool && input.tool !== input.permission
    ? `${input.permission} via ${input.tool}`
    : input.permission;
  return { title: clip(redactPreviewText(title)), lines, risk: riskOf(input.permission, input.patterns) };
}
