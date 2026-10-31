// Observation redaction: page text and console lines are scrubbed of
// credential-looking material before they can reach events or the model.

export interface RedactOptions {
  /** Extra literal secrets (configured values) to strip wherever they appear. */
  secrets?: ReadonlyArray<string>;
  /** Secrets introduced through a privileged broker. Unlike heuristic/config
   * redaction, these are stripped even when shorter than four characters. */
  strictSecrets?: ReadonlyArray<string>;
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
  for (const secret of opts.strictSecrets ?? []) {
    if (secret.length === 0) continue;
    const variants = new Set<string>([secret]);
    try {
      const encoded = encodeURIComponent(secret);
      variants.add(encoded);
      variants.add(encoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()));
      variants.add(encoded.replace(/%20/g, "+"));
    } catch {
      // Lone surrogate values are still scrubbed literally below.
    }
    try {
      const json = JSON.stringify(secret);
      if (json.length >= 2) variants.add(json.slice(1, -1));
    } catch {
      // Strings are normally serializable; literal scrubbing remains enough.
    }
    for (const variant of variants) {
      if (variant.length > 0) out = out.split(variant).join("[redacted]");
    }
  }
  const cap = opts.maxChars ?? 20_000;
  if (out.length > cap) out = `${out.slice(0, cap)}\n…[truncated]`;
  return out;
}

/** Safe URL form for browser runtime events and durable metadata. URL
 * credentials, queries, and fragments may contain bearer material even when
 * the surrounding URL looks innocuous. */
export function redactUrl(raw: string, maxChars = 500): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    if (url.search) url.search = "?[redacted]";
    if (url.hash) url.hash = "#[redacted]";
    return redactObservationText(url.toString(), { maxChars });
  } catch {
    return redactObservationText(raw, { maxChars });
  }
}
