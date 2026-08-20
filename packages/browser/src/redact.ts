// Observation redaction (WP14): page text and console lines are scrubbed of
// credential-looking material before they can reach events or the model.

export interface RedactOptions {
  /** Extra literal secrets (configured values) to strip wherever they appear. */
  secrets?: ReadonlyArray<string>;
  maxChars?: number;
}

const PATTERNS: ReadonlyArray<RegExp> = [
  /\b(authorization|proxy-authorization)\s*[:=][^\n]+/gi,
  /\b(bearer|basic)\s+[a-z0-9._~+/=-]{8,}/gi,
  /\b(set-)?cookie\s*[:=]\s*\S+/gi,
  /\b(api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*\S+/gi,
  /\bsk-[a-zA-Z0-9_-]{8,}/g,
  /\bgh[pousr]_[a-zA-Z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{5,}\b/g, // JWT
];

export function redactObservationText(text: string, opts: RedactOptions = {}): string {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, "[redacted]");
  for (const secret of opts.secrets ?? []) {
    if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  const cap = opts.maxChars ?? 20_000;
  if (out.length > cap) out = `${out.slice(0, cap)}\n…[truncated]`;
  return out;
}
