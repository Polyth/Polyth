/** Pure bootstrap adapter: encode/decode pairing strings. No secrets, no auth. */

export const PAIRING_SCHEME = "polyth://pair";
const RAW_LIMIT = 16 * 1024;

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
