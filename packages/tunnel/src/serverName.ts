// The name paired phones show for this server. The owner sets it on the
// Polyth Link page; until then it is the computer's host name. New pairing
// tickets carry it, and the Link host sends it to every paired device when it
// connects, so a phone that has not renamed the server follows changes.
// Browser-safe: the Link page imports the DTO and limits from here.

/** Matches the Link ticket's `host.label` limit (`Limits::label_chars`). */
export const SERVER_NAME_MAX_CHARS = 80;

export interface TunnelServerNameDto {
  /** The owner's name for this server; empty until one is set. */
  name: string;
  /** What phones see while `name` is empty. */
  fallback: string;
  /** Only the server owner may change the name. */
  editable: boolean;
}

/** One printable line of at most `SERVER_NAME_MAX_CHARS` characters, the
 *  same rule the Link host applies (`clean_label`). */
export function cleanServerName(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  const words = text.split(/[\s\p{Cc}]+/u).filter(Boolean).join(" ");
  return Array.from(words).slice(0, SERVER_NAME_MAX_CHARS).join("").trimEnd();
}

/** "studio.local" → "studio"; an empty host name falls back to "Polyth". */
export function fallbackServerName(hostname: string): string {
  return cleanServerName(hostname.split(".")[0]) || "Polyth";
}
