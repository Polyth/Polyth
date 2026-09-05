export const ACTION_ICONS = [
  "terminal",
  "play",
  "sparkles",
  "refresh",
  "target",
  "globe",
  "package",
  "bell",
  "clock",
  "send",
] as const;

export type ActionIcon = typeof ACTION_ICONS[number];
export type ActionOutput = "terminal" | "popup";

export interface ActionConfig {
  label: string;
  command: string;
  icon: ActionIcon;
  output: ActionOutput;
}

export function actionConfig(value: Readonly<Record<string, unknown>>): ActionConfig {
  const icon = typeof value.icon === "string" && ACTION_ICONS.includes(value.icon as ActionIcon)
    ? value.icon as ActionIcon
    : "terminal";
  return {
    label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : "Run action",
    command: typeof value.command === "string" ? value.command : "",
    icon,
    output: value.output === "popup" ? "popup" : "terminal",
  };
}
