export type ComposerLayoutState = "desktop" | "phone-resting" | "phone-engaged";

export function composerLayoutState(input: {
  phoneLayout: boolean;
  inputFocused: boolean;
  shellMode: boolean;
  hasDraft: boolean;
}): ComposerLayoutState {
  if (!input.phoneLayout) return "desktop";
  return input.inputFocused || input.shellMode || input.hasDraft
    ? "phone-engaged"
    : "phone-resting";
}
