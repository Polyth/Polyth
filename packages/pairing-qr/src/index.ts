/** Pure bootstrap adapter: encode/decode pairing strings. No secrets, no auth. */

export const PAIRING_SCHEME = "polyth://pair";
const RAW_LIMIT = 16 * 1024;

/**
 * The invitation link keeps its payload in `t`, whether it arrives as the app's
 * own deep link or as the clickable https page. Only the exact host and path
 * count; a lookalike host or another scheme is not a pairing link.
 */
const LINK_PATTERN = /(?:^|[^A-Za-z0-9_.-])(?:polyth:\/\/pair\/?\?|https:\/\/polyth\.app\/join\/?#)v=1&t=([A-Za-z0-9_-]+)/;

/**
 * Pulls the first pairing link out of whatever a person pasted or the OS handed
 * over (a whole invitation message included) and returns its canonical form.
 */
export function pairingLinkFromText(raw: string): string | null {
  if (raw.length > RAW_LIMIT) return null;
  const match = LINK_PATTERN.exec(raw);
  if (!match) return null;
  const tail = raw[match.index + match[0].length] ?? "";
  // Tabs and line breaks separate a link from the rest of a pasted message;
  // a slash or other control byte means the token is not a whole link.
  if (tail === "/" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(tail)) return null;
  return `polyth://pair?v=1&t=${match[1]}`;
}

export function isPairingLink(raw: string): boolean {
  const value = raw.trim();
  return value.startsWith("polyth://pair?") || value.startsWith("polyth://pair/?");
}

export function previewPairingLink(raw: string): { ok: true } | { ok: false; reason: string } {
  const value = raw.trim();
  if (value.length > RAW_LIMIT) return { ok: false, reason: "pairing-invalid" };
  if (!isPairingLink(value)) return { ok: false, reason: "pairing-invalid" };
  if (value.includes("\0") || /[\u0000-\u001f]/.test(value)) return { ok: false, reason: "pairing-invalid" };
  return { ok: true };
}

export function qrModulesFromPayload(payload: string): boolean[][] {
  // Compact byte-mode QR is provided by the native host for production scans.
  // The web UI uses this deterministic matrix as a visual stand-in so the same
  // pairing string is obvious without shipping a second encoder.
  const bytes = [...new TextEncoder().encode(payload)];
  const size = 33;
  const modules = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  for (let i = 0; i < bytes.length; i++) {
    const x = (i * 7 + bytes[i]!) % size;
    const y = (i * 13 + (bytes[i]! >> 3)) % size;
    modules[y]![x] = true;
    modules[(y + 2) % size]![(x + 5) % size] = (bytes[i]! & 1) === 1;
  }
  for (let i = 0; i < size; i++) {
    modules[0]![i] = i % 2 === 0;
    modules[i]![0] = i % 2 === 0;
    modules[size - 1]![i] = true;
    modules[i]![size - 1] = true;
  }
  return modules;
}
