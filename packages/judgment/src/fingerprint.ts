import type { JudgmentQuestionMap } from "./types.ts";

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : value;

/** SHA-256 of semantics only. State and credentials never enter the fingerprint. */
export async function questionSetId(scope: string, questions: JudgmentQuestionMap): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical({ scope, questions })));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
