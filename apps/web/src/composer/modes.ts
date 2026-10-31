// Pure decisions behind composer modes (web-sdk `ComposerMode`): trigger
// detection and the leave gestures. Composer.tsx owns state and rendering.

export interface ModeTriggerSource {
  id: string;
  trigger?: string;
}

/** The mode a draft enters when it starts with a mode's trigger followed by
 *  whitespace ("/btw " → btw), and the draft with the trigger removed. A bare
 *  trigger (still being typed, or a slash command that shares its prefix)
 *  never enters. Matching ignores case so a keyboard's auto-capital still
 *  counts. */
export function detectModeTrigger(
  text: string,
  modes: readonly ModeTriggerSource[],
): { modeId: string; rest: string } | null {
  for (const mode of modes) {
    const trigger = mode.trigger;
    if (!trigger || /\s/.test(trigger)) continue;
    if (text.length <= trigger.length) continue;
    if (text.slice(0, trigger.length).toLowerCase() !== trigger.toLowerCase()) continue;
    if (!/\s/.test(text[trigger.length]!)) continue;
    return { modeId: mode.id, rest: text.slice(trigger.length + 1) };
  }
  return null;
}

export interface ModeLeaveKeyInput {
  key: string;
  text: string;
  selectionStart: number;
  selectionEnd: number;
  composing: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** Esc in an empty draft, or Backspace at the start of an empty draft, leaves
 *  the mode. Anything typed keeps it: those keys edit the draft instead. */
export function isModeLeaveKey(input: ModeLeaveKeyInput): boolean {
  if (input.composing || input.altKey || input.ctrlKey || input.metaKey) return false;
  if (input.text !== "") return false;
  if (input.key === "Escape") return !input.shiftKey;
  if (input.key === "Backspace") return input.selectionStart === 0 && input.selectionEnd === 0;
  return false;
}

/** Labels and placeholders may be functions so a locale switch stays live. */
export function modeText(value: string | (() => string) | undefined): string {
  if (typeof value === "function") {
    try { return value(); } catch { return ""; }
  }
  return value ?? "";
}
