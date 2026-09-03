export const PROMPT_VISIBILITY_EVENT = "polyth:prompt-visibility";

export function publishPromptVisibility(visible: boolean): void {
  document.body.dataset.promptVisible = visible ? "true" : "false";
  window.dispatchEvent(new CustomEvent(PROMPT_VISIBILITY_EVENT, { detail: visible }));
}

export function promptIsVisible(): boolean {
  return document.body.dataset.promptVisible === "true";
}
