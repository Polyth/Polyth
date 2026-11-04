// Settings > Chat reads as a summary: one Level of detail, then one-line rows
// that open in place beside a live preview. Pure (no DOM, no React), so the page
// and its tests share the level mapping and the routing of search hits to rows.
import {
  ASSISTANT_MESSAGE_ACTIONS_DEFAULT,
  USER_MESSAGE_ACTIONS_DEFAULT,
  type MessageActionReveal,
  type MessageActionTouchReveal,
} from "../../messageActionLayout.ts";
import type { UiSettings } from "../../uiPrefs.ts";

export const CHAT_DETAIL_LEVELS = ["minimal", "balanced", "detailed"] as const;
export type ChatDetailLevel = typeof CHAT_DETAIL_LEVELS[number];

export type ChatDetailPrefs = Pick<
  UiSettings,
  "actionGrouping" | "activityBlockStyle" | "thinkingDisplayMode" | "promptNavigator" | "userMessageActions" | "assistantMessageActions"
>;

interface LevelDefinition {
  actionGrouping: UiSettings["actionGrouping"];
  activityBlockStyle: UiSettings["activityBlockStyle"];
  thinkingDisplayMode: UiSettings["thinkingDisplayMode"];
  /** The rail is on or off here; its stored on-mode is the person's own. */
  promptRail: boolean;
  user: { reveal: MessageActionReveal; touch: MessageActionTouchReveal };
  assistant: { reveal: MessageActionReveal; touch: MessageActionTouchReveal };
}

/** A level only sets how much the conversation shows. Which buttons exist and
 *  where they sit, and everything about typing and sending, stay the person's.
 *  Balanced is the install defaults (pinned in chatSettingsPage.test.ts). */
const LEVELS: Readonly<Record<ChatDetailLevel, LevelDefinition>> = {
  minimal: {
    actionGrouping: "grouped",
    activityBlockStyle: "chip",
    thinkingDisplayMode: "activity",
    promptRail: false,
    user: { reveal: "hover", touch: "menu" },
    assistant: { reveal: "hover", touch: "menu" },
  },
  balanced: {
    actionGrouping: "grouped",
    activityBlockStyle: "thread",
    thinkingDisplayMode: "collapsed",
    promptRail: true,
    user: { reveal: USER_MESSAGE_ACTIONS_DEFAULT.reveal, touch: USER_MESSAGE_ACTIONS_DEFAULT.touch },
    assistant: { reveal: ASSISTANT_MESSAGE_ACTIONS_DEFAULT.reveal, touch: ASSISTANT_MESSAGE_ACTIONS_DEFAULT.touch },
  },
  detailed: {
    actionGrouping: "ungrouped",
    activityBlockStyle: "thread",
    thinkingDisplayMode: "expanded",
    promptRail: true,
    user: { reveal: "always", touch: "always" },
    assistant: { reveal: "always", touch: "always" },
  },
};

/** The preferences one level writes. Button placements and order survive. */
export function chatDetailPatch(level: ChatDetailLevel, prefs: ChatDetailPrefs): ChatDetailPrefs {
  const definition = LEVELS[level];
  return {
    actionGrouping: definition.actionGrouping,
    activityBlockStyle: definition.activityBlockStyle,
    thinkingDisplayMode: definition.thinkingDisplayMode,
    promptNavigator: !definition.promptRail ? "off" : prefs.promptNavigator === "off" ? "auto" : prefs.promptNavigator,
    userMessageActions: { ...prefs.userMessageActions, ...definition.user },
    assistantMessageActions: { ...prefs.assistantMessageActions, ...definition.assistant },
  };
}

/** The level the preferences currently match, or null for a hand-made mix.
 *  Ungrouped steps have no block to style, so their style does not count. */
export function chatDetailLevelOf(prefs: ChatDetailPrefs): ChatDetailLevel | null {
  return CHAT_DETAIL_LEVELS.find((level) => {
    const definition = LEVELS[level];
    return prefs.actionGrouping === definition.actionGrouping
      && (prefs.actionGrouping === "ungrouped" || prefs.activityBlockStyle === definition.activityBlockStyle)
      && prefs.thinkingDisplayMode === definition.thinkingDisplayMode
      && (prefs.promptNavigator !== "off") === definition.promptRail
      && prefs.userMessageActions.reveal === definition.user.reveal
      && prefs.userMessageActions.touch === definition.user.touch
      && prefs.assistantMessageActions.reveal === definition.assistant.reveal
      && prefs.assistantMessageActions.touch === definition.assistant.touch;
  }) ?? null;
}

/** Every row that opens in place and the settings behind it. A closed row does
 *  not render its settings, so a search hit or deep link on one of them arrives
 *  as the page's target and opens the row first. */
export const CHAT_ROW_ITEMS = {
  steps: ["chat.actionBlocks", "chat.activityStyle"],
  thinking: ["chat.thinking"],
  send: ["chat.sendOnEnter", "chat.mobileSendShortcut"],
  followUp: ["chat.followUp"],
  paste: ["chat.largePaste"],
  userActions: ["chat.messageActions"],
  replies: ["chat.responseActions"],
  composer: ["chat.showDictate", "chat.showQuickActions"],
  navigation: ["chat.promptNavigator", "chat.promptNavigatorSide", "chat.pinLatestPrompt", "chat.promptBookmarkDesktop", "chat.pinLatestPromptPosition"],
  header: ["chat.mobileSessionTitle"],
} as const;
export type ChatRowId = keyof typeof CHAT_ROW_ITEMS;

/** Settings behind the page's "More options". */
export const CHAT_MORE_ITEMS: readonly string[] = ["chat.copyFormat", "chat.promptHistory", "chat.promptHistoryLimit", "chat.activityDetails"];

/** Always on the page: never behind a row or "More options". */
export const CHAT_ALWAYS_VISIBLE_ITEMS: readonly string[] = ["chat.detailLevel", "chat.width"];

export function chatRowOfItem(itemId: string | undefined): ChatRowId | null {
  if (!itemId) return null;
  const rows = Object.keys(CHAT_ROW_ITEMS) as ChatRowId[];
  return rows.find((row) => (CHAT_ROW_ITEMS[row] as readonly string[]).includes(itemId)) ?? null;
}

export function chatItemInMore(itemId: string | undefined): boolean {
  return itemId !== undefined && CHAT_MORE_ITEMS.includes(itemId);
}

export type ChatPreviewPart = "header" | "user" | "steps" | "thinking" | "answer" | "replies" | "composer" | "send" | "rail";

/** What stays lit in the preview while a row is open. Thinking hidden in the
 *  activity block lives in the steps, so the steps light up with it. */
export function chatPreviewFocus(row: ChatRowId | null, prefs: Pick<UiSettings, "thinkingDisplayMode">): readonly ChatPreviewPart[] {
  switch (row) {
    case null: return [];
    case "steps": return ["steps"];
    case "thinking": return prefs.thinkingDisplayMode === "activity" ? ["steps"] : ["thinking"];
    case "send": return ["send"];
    case "followUp":
    case "paste":
    case "composer": return ["composer"];
    case "userActions": return ["user"];
    case "replies": return ["replies"];
    case "navigation": return ["rail"];
    case "header": return ["header"];
  }
}

/** The row a click on the preview opens. The answer has no row of its own: its
 *  one setting, the width, sits on the page without opening. */
export const CHAT_PREVIEW_ROW: Readonly<Record<Exclude<ChatPreviewPart, "answer">, ChatRowId>> = {
  header: "header",
  user: "userActions",
  steps: "steps",
  thinking: "thinking",
  replies: "replies",
  composer: "composer",
  send: "send",
  rail: "navigation",
};
