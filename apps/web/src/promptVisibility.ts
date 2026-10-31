export const PROMPT_VISIBILITY_EVENT = "polyth:prompt-visibility";

/** Publish whether the latest prompt is on screen. Called on every scroll and
 *  resize, so only a change is written: any attribute write on <body>, even
 *  of the same value, made Chromium re-match the shell's `:has()` rules and
 *  restyle the whole document while a streamed answer followed the tail. */
export function publishPromptVisibility(visible: boolean): void {
  const value = visible ? "true" : "false";
  if (document.body.dataset.promptVisible === value) return;
  document.body.dataset.promptVisible = value;
  window.dispatchEvent(new CustomEvent(PROMPT_VISIBILITY_EVENT, { detail: visible }));
}

export function promptIsVisible(): boolean {
  return document.body.dataset.promptVisible === "true";
}
