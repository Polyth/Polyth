/**
 * Canonical English messages owned by the ide-mode package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "idemode.profile.description": "Files and editor on the left, sessions and chat on the right.",
} as const;

export type IdeModeMessageKey = keyof typeof en;
export type IdeModeMessages = Record<IdeModeMessageKey, string>;
