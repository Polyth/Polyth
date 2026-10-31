// One quick-action layout model for both conversation roles. A user prompt and
// an assistant answer each carry an ordered list of actions; every action is
// placed on the visible bar, in the "More" menu, or turned off, and each role
// chooses how its bar reveals on fine pointers and on touch screens. The
// Settings editor and both message footers read the same shape, so the two
// roles are configured identically. Package buttons (`session.message.actions`
// slot contributions) join the same list under a `pkg:<contribution id>` key,
// so every button under a message is placed, ordered and switched off the
// same way.
//
// Pure module (no DOM, no React) so node:test can pin parsing and resolution.

export type MessageActionRole = "user" | "assistant";
export type UserMessageActionId = "copy" | "revert" | "fork" | "pin" | "session";
export type ResponseActionId = "copy" | "regenerate" | "pin" | "info" | "session" | "image";
export type MessageActionId = UserMessageActionId | ResponseActionId;
/** A package contribution's slot in a layout: `pkg:<contribution id>`. */
export type PackageMessageActionId = `pkg:${string}`;
export type WithPackageActions<T extends string> = T | PackageMessageActionId;
export type MessageActionPlacement = "bar" | "menu" | "off";
/** Fine-pointer presentation: always visible, revealed on hover/focus, or
 *  every action behind the "More" button. */
export type MessageActionReveal = "always" | "hover" | "menu";
/** Touch presentation. Touch has no hover, so the bar is either always
 *  visible or folded behind the "More" button. */
export type MessageActionTouchReveal = "always" | "menu";

export interface MessageActionItem<T extends string> {
  id: T;
  placement: MessageActionPlacement;
}

export interface MessageActionLayout<T extends string> {
  /** Every known action in display order; `off` items keep their slot so
   *  turning one back on restores it where the user left it. */
  items: Array<MessageActionItem<T>>;
  reveal: MessageActionReveal;
  touch: MessageActionTouchReveal;
  /** Placements stored under ids this build no longer knows (retired
   *  built-ins), so a package contribution that `replaces` one inherits it. */
  retired?: Readonly<Record<string, MessageActionPlacement>>;
}

export const USER_MESSAGE_ACTION_IDS: readonly UserMessageActionId[] = ["copy", "revert", "fork", "pin", "session"];
export const RESPONSE_ACTION_IDS: readonly ResponseActionId[] = ["copy", "regenerate", "pin", "info", "session", "image"];
export const MESSAGE_ACTION_REVEALS: readonly MessageActionReveal[] = ["always", "hover", "menu"];
export const MESSAGE_ACTION_TOUCH_REVEALS: readonly MessageActionTouchReveal[] = ["always", "menu"];
const PLACEMENTS: readonly MessageActionPlacement[] = ["bar", "menu", "off"];

export const USER_MESSAGE_ACTIONS_DEFAULT: MessageActionLayout<UserMessageActionId> = {
  items: [
    { id: "copy", placement: "bar" },
    { id: "revert", placement: "bar" },
    { id: "fork", placement: "bar" },
    { id: "session", placement: "bar" },
    { id: "pin", placement: "bar" },
  ],
  reveal: "hover",
  touch: "always",
};

export const ASSISTANT_MESSAGE_ACTIONS_DEFAULT: MessageActionLayout<ResponseActionId> = {
  items: [
    { id: "info", placement: "bar" },
    { id: "copy", placement: "bar" },
    { id: "pin", placement: "off" },
    { id: "session", placement: "off" },
    { id: "regenerate", placement: "off" },
    { id: "image", placement: "off" },
  ],
  reveal: "hover",
  touch: "menu",
};

export function cloneMessageActionLayout<T extends string>(layout: MessageActionLayout<T>): MessageActionLayout<T> {
  return {
    items: layout.items.map((item) => ({ ...item })),
    ...(layout.retired ? { retired: { ...layout.retired } } : {}),
    reveal: layout.reveal,
    touch: layout.touch,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const PACKAGE_ACTION_ID = /^pkg:[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

export function packageMessageActionId(contributionId: string): PackageMessageActionId {
  return `pkg:${contributionId}`;
}

export function isPackageMessageActionId(id: unknown): id is PackageMessageActionId {
  return typeof id === "string" && PACKAGE_ACTION_ID.test(id);
}

/** Normalize a stored layout. Unknown/duplicate ids drop out; actions this
 *  build added since the record was written join at their default placement.
 *  Package entries are kept even while their package is off, so turning it
 *  back on restores the user's choice. */
export function parseMessageActionLayout<T extends string>(
  value: unknown,
  ids: readonly T[],
  fallback: MessageActionLayout<T>,
): MessageActionLayout<WithPackageActions<T>> {
  if (!isRecord(value)) return cloneMessageActionLayout(fallback);
  const items: Array<MessageActionItem<WithPackageActions<T>>> = [];
  const retired: Record<string, MessageActionPlacement> = {};
  const seen = new Set<string>();
  if (Array.isArray(value.items)) {
    for (const raw of value.items) {
      if (!isRecord(raw)) continue;
      const id = raw.id as WithPackageActions<T>;
      if (typeof id !== "string" || seen.has(id)) continue;
      const placement = PLACEMENTS.includes(raw.placement as MessageActionPlacement)
        ? raw.placement as MessageActionPlacement
        : "off";
      if (!ids.includes(id as T) && !isPackageMessageActionId(id)) {
        if (/^[a-z][a-z0-9-]{0,63}$/.test(id)) retired[id] = placement;
        continue;
      }
      seen.add(id);
      items.push({ id, placement });
    }
  }
  for (const item of fallback.items) {
    if (!seen.has(item.id)) items.push({ ...item });
  }
  return {
    items,
    ...(Object.keys(retired).length > 0 ? { retired } : {}),
    reveal: MESSAGE_ACTION_REVEALS.includes(value.reveal as MessageActionReveal)
      ? value.reveal as MessageActionReveal
      : fallback.reveal,
    touch: MESSAGE_ACTION_TOUCH_REVEALS.includes(value.touch as MessageActionTouchReveal)
      ? value.touch as MessageActionTouchReveal
      : fallback.touch,
  };
}

/** Builds before the shared layout stored only an ordered `responseActions`
 *  list (Info and Regenerate were always shown). An untouched default list
 *  adopts today's curated default; a customised one keeps exactly the buttons
 *  the user chose, on the bar, in their order. */
export function migrateLegacyResponseActions(legacy: unknown): MessageActionLayout<ResponseActionId> {
  const fallback = ASSISTANT_MESSAGE_ACTIONS_DEFAULT;
  if (!Array.isArray(legacy)) return cloneMessageActionLayout(fallback);
  // The pre-layout default list, kept verbatim so an untouched record adopts
  // today's curated default. Plan and Multi-run moved to package
  // contributions; a custom legacy list keeps only the remaining built-ins.
  const legacyDefault = ["copy", "image", "plan", "pin", "session", "multirun"];
  if (legacy.length === legacyDefault.length && legacy.every((id, index) => id === legacyDefault[index])) {
    return cloneMessageActionLayout(fallback);
  }
  const legacyIds: readonly string[] = ["copy", "image", "pin", "session"];
  const chosen = legacy.filter((id, index): id is ResponseActionId =>
    typeof id === "string" && legacyIds.includes(id) && legacy.indexOf(id) === index);
  const ordered: ResponseActionId[] = ["info", ...chosen, "regenerate"];
  const items: Array<MessageActionItem<ResponseActionId>> = ordered.map((id) => ({ id, placement: "bar" }));
  for (const id of RESPONSE_ACTION_IDS) {
    if (!ordered.includes(id)) items.push({ id, placement: "off" });
  }
  // Retired built-ins the person chose stay on the bar once their package
  // contribution (which `replaces` the id) appears.
  const retired: Record<string, MessageActionPlacement> = {};
  for (const id of ["plan", "multirun"]) if (legacy.includes(id)) retired[id] = "bar";
  return {
    items,
    ...(Object.keys(retired).length > 0 ? { retired } : {}),
    reveal: fallback.reveal,
    touch: fallback.touch,
  };
}

/** One package contribution as the layout sees it. */
export interface PackageMessageActionSlot {
  id: PackageMessageActionId;
  /** Whether the contribution can be opened from the "More" menu. Bar-only
   *  contributions (their own popover anchored to their own button…) keep a
   *  "menu" placement on the bar instead. */
  menu: boolean;
  /** Placement for someone who never placed it; "bar" when omitted. */
  defaultPlacement?: MessageActionPlacement;
  /** Retired built-in ids whose stored placement this contribution inherits. */
  replaces?: readonly string[];
}

/** Package contributions the stored layout has never seen join at the end:
 *  at the placement a retired built-in they replace had, else at their
 *  declared default, else on the bar as before they were configurable. */
export function withPackageMessageActions<T extends string>(
  layout: MessageActionLayout<T>,
  packages: readonly PackageMessageActionSlot[],
): MessageActionLayout<WithPackageActions<T>> {
  const known = new Set<string>(layout.items.map((item) => item.id));
  const missing = packages.filter((slot) => !known.has(slot.id));
  if (missing.length === 0) return layout;
  return {
    ...layout,
    items: [
      ...layout.items.map((item) => ({ ...item })),
      ...missing.map((slot) => ({
        id: slot.id,
        placement: slot.replaces?.map((id) => layout.retired?.[id]).find((placement) => placement !== undefined)
          ?? slot.defaultPlacement
          ?? "bar" as const,
      })),
    ],
  };
}

export interface ResolvedMessageActions<T extends string> {
  /** Presentation actually in effect for this pointer. */
  mode: MessageActionReveal;
  bar: T[];
  menu: T[];
}

/** Resolve one footer: which actions sit on the bar and which in the menu for
 *  the current pointer. Actions the message cannot offer (no revert target,
 *  package disabled…) are skipped without disturbing the others' order. An
 *  action that cannot live in a menu (`menuCapable` false) stays on the bar. */
export function resolveMessageActions<T extends string>(
  layout: MessageActionLayout<T>,
  available: (id: T) => boolean,
  touch: boolean,
  menuCapable: (id: T) => boolean = () => true,
): ResolvedMessageActions<T> {
  const mode: MessageActionReveal = touch ? layout.touch : layout.reveal;
  const enabled = layout.items.filter((item) => item.placement !== "off" && available(item.id));
  const inMenu = (item: MessageActionItem<T>) =>
    (mode === "menu" || item.placement === "menu") && menuCapable(item.id);
  return {
    mode,
    bar: enabled.filter((item) => !inMenu(item)).map((item) => item.id),
    menu: enabled.filter(inMenu).map((item) => item.id),
  };
}

export function setMessageActionPlacement<T extends string>(
  layout: MessageActionLayout<T>,
  id: T,
  placement: MessageActionPlacement,
): MessageActionLayout<T> {
  return { ...layout, items: layout.items.map((item) => (item.id === id ? { id, placement } : { ...item })) };
}

/** Move one action to `toIndex` (clamped) in the full ordered list. */
export function moveMessageAction<T extends string>(
  layout: MessageActionLayout<T>,
  id: T,
  toIndex: number,
): MessageActionLayout<T> {
  const from = layout.items.findIndex((item) => item.id === id);
  if (from < 0) return layout;
  const items = layout.items.map((item) => ({ ...item }));
  const [moved] = items.splice(from, 1);
  const target = Math.max(0, Math.min(items.length, Math.round(toIndex)));
  items.splice(target, 0, moved!);
  return { ...layout, items };
}

export function sameMessageActionLayout<T extends string>(a: MessageActionLayout<T>, b: MessageActionLayout<T>): boolean {
  return a.reveal === b.reveal
    && a.touch === b.touch
    && a.items.length === b.items.length
    && a.items.every((item, index) => item.id === b.items[index]?.id && item.placement === b.items[index]?.placement);
}
