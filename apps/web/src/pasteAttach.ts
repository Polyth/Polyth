/** Large-paste detection and attach helper for composer / selection attach. */

export const LARGE_PASTE_CHAR_THRESHOLD = 2000;
export const LARGE_PASTE_LINE_THRESHOLD = 25;

/** True when pasted/selected text exceeds the char or line threshold. */
export function isLargeTextPaste(text: string): boolean {
  if (text.length >= LARGE_PASTE_CHAR_THRESHOLD) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      lines += 1;
      if (lines >= LARGE_PASTE_LINE_THRESHOLD) return true;
    }
  }
  return false;
}

/** Predictable `_inbox` filename — no language guessing. */
export function suggestPasteFilename(index: number): string {
  const n = Number.isFinite(index) && index >= 1 ? Math.floor(index) : 1;
  return `pasted-context-${n}.txt`;
}

/** Human-readable size for the ask banner (bytes → B / KB). */
export function formatPasteSize(bytes: number): string {
  const n = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  if (n < 1024) return `${Math.round(n)} B`;
  const kb = n / 1024;
  if (kb < 10) return `${(Math.round(kb * 10) / 10).toFixed(1)} KB`;
  return `${Math.round(kb)} KB`;
}

/** UTF-8 byte length of a string (for size labels). */
export function pasteByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return text.length;
}

export type AttachTextResult = { ok: true } | { ok: false; reason: string; name: string };

/**
 * Upload pasted/selected text as a plain `_inbox` attachment for the given
 * origin session/project (captured by the caller so a later switch cannot
 * retarget the write).
 */
export async function attachText(
  projectId: string,
  sessionId: string | null | undefined,
  text: string,
  index: number,
  upload: (
    projectId: string,
    sessionId: string | null | undefined,
    file: File,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>,
): Promise<AttachTextResult> {
  const name = suggestPasteFilename(index);
  const file = new File([text], name, { type: "text/plain" });
  const result = await upload(projectId, sessionId, file);
  if (!result.ok) return { ok: false, reason: result.reason, name };
  return { ok: true };
}
