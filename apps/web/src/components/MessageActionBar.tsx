// The quick-action bar under a user message or an assistant answer. Both roles
// hand it their action definitions plus the role's configured layout; this
// component decides, for the current pointer, which actions sit on the bar,
// which fold into the "More" menu, and how the bar reveals. Package buttons
// (`session.message.actions`) are entries of the same layout: on the bar they
// render themselves; in the menu the host lists them and keeps them mounted
// without a trigger, signalling a selection through `messageActionRequest`.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  isPackageMessageActionId,
  resolveMessageActions,
  withPackageMessageActions,
  type MessageActionLayout,
  type MessageActionRole,
  type PackageMessageActionId,
} from "../messageActionLayout.ts";
import ChatActionButton from "./ChatActionButton.tsx";
import { MESSAGE_ACTIONS_SLOT, useMessageActionContributions } from "./messageActionContributions.ts";
import { SlotBoundary, type SlotContext } from "./slots/SlotHost.ts";
import { CheckIcon, Menu, MoreIcon, type LucideIcon, type MenuEntry } from "./ui/index.ts";
import "./ChatChrome.css";

export interface MessageActionDef<T extends string> {
  id: T;
  icon: LucideIcon;
  /** Accessible name and tooltip on the bar. */
  label: string;
  /** Shorter visible text in the menu; defaults to `label`. */
  menuLabel?: string;
  /** Why the action is unavailable; shown as menu detail and appended to the
   *  bar label. */
  disabledReason?: string;
  disabled?: boolean;
  pressed?: boolean;
  /** Disclosure state for an action that opens a popup (response details). */
  expanded?: boolean;
  busy?: boolean;
  /** Extra attributes for the bar button (stable test/automation hooks). */
  data?: Record<`data-${string}`, string | number>;
  run: (anchor: HTMLElement | null) => void;
}

// Touch has no hover: the same query the bar's CSS reveal rules use.
const TOUCH_QUERY = "(hover: none), (pointer: coarse)";

function subscribeTouch(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(TOUCH_QUERY);
  media.addEventListener?.("change", callback);
  return () => media.removeEventListener?.("change", callback);
}

const touchSnapshot = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(TOUCH_QUERY).matches;

export function useTouchPointer(): boolean {
  return useSyncExternalStore(subscribeTouch, touchSnapshot, () => false);
}

/** Brief green-check acknowledgement shared by every action in one bar. */
export function useActionConfirmation(): [string | null, (id: string) => void] {
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  const confirm = (id: string) => {
    if (timer.current !== null) clearTimeout(timer.current);
    setConfirmed(id);
    timer.current = setTimeout(() => {
      setConfirmed(null);
      timer.current = null;
    }, 1_000);
  };
  return [confirmed, confirm];
}

export default function MessageActionBar<T extends string>({
  role,
  layout,
  actions,
  confirmed,
  label,
  moreLabel,
  className,
  id,
  hidden = false,
  data,
  context,
}: {
  role: MessageActionRole;
  /** The role's stored layout; package entries may be among its items. */
  layout: MessageActionLayout<T | PackageMessageActionId>;
  /** Actions this message can offer; ids missing here are skipped. */
  actions: ReadonlyArray<MessageActionDef<T>>;
  confirmed?: string | null;
  /** Accessible name of the action group. */
  label: string;
  moreLabel: string;
  className?: string;
  id?: string;
  /** Keep the bar's box but hide it (answer footers must not reflow). */
  hidden?: boolean;
  /** Extra attributes for the group (stable row hooks). */
  data?: Record<`data-${string}`, string | number>;
  /** Host context for package contributions (session, message, role…). */
  context: SlotContext;
}) {
  const touch = useTouchPointer();
  const [menuOpen, setMenuOpen] = useState(false);
  const [requests, setRequests] = useState<Partial<Record<PackageMessageActionId, number>>>({});
  const barRef = useRef<HTMLDivElement>(null);
  const contributions = useMessageActionContributions(role);
  const byPackage = new Map(contributions.map((entry) => [entry.id, entry]));
  const byId = new Map(actions.map((action) => [action.id as string, action]));
  const resolved = resolveMessageActions(
    withPackageMessageActions(layout, contributions),
    (actionId) => (isPackageMessageActionId(actionId) ? byPackage.has(actionId) : byId.has(actionId)),
    touch,
    (actionId) => !isPackageMessageActionId(actionId) || byPackage.get(actionId)!.menu,
  );
  const menuIds = resolved.menu.filter((actionId) =>
    !isPackageMessageActionId(actionId) || byPackage.get(actionId)!.available(context));
  const menuConfirmed = confirmed != null && menuIds.some((actionId) => actionId === confirmed);
  const anchor = () => barRef.current;
  const packageView = (actionId: PackageMessageActionId, placement: "bar" | "menu") => (
    <SlotBoundary
      key={actionId}
      slot={MESSAGE_ACTIONS_SLOT}
      item={byPackage.get(actionId)!.item}
      context={{
        ...context,
        messageActionPlacement: placement,
        messageActionRequest: requests[actionId] ?? 0,
        messageActionAnchor: anchor,
      }}
    />
  );
  const menuEntries: MenuEntry[] = menuIds.map((actionId) => {
    if (isPackageMessageActionId(actionId)) {
      const entry = byPackage.get(actionId)!;
      return {
        id: actionId,
        label: entry.label,
        icon: entry.icon,
        onSelect: () => setRequests((current) => ({ ...current, [actionId]: (current[actionId] ?? 0) + 1 })),
      };
    }
    const action = byId.get(actionId)!;
    return {
      id: action.id,
      label: action.menuLabel ?? action.label,
      icon: action.icon,
      ...(action.disabledReason ? { detail: action.disabledReason } : {}),
      disabled: action.disabled === true || action.busy === true,
      onSelect: () => action.run(barRef.current),
    };
  });
  const headless = menuIds.filter(isPackageMessageActionId);

  useEffect(() => {
    if (hidden) setMenuOpen(false);
  }, [hidden]);

  return (
    <div
      ref={barRef}
      id={id}
      className={["chat-action-bar", className ?? ""].filter(Boolean).join(" ")}
      role="group"
      aria-label={label}
      data-role={role}
      data-reveal={resolved.mode}
      data-open={menuOpen ? "true" : undefined}
      data-hidden={hidden ? "true" : undefined}
      {...data}
    >
      {resolved.bar.map((actionId) => {
        if (isPackageMessageActionId(actionId)) return packageView(actionId, "bar");
        const action = byId.get(actionId)!;
        const isConfirmed = confirmed === action.id;
        return (
          <ChatActionButton
            key={action.id}
            icon={isConfirmed ? CheckIcon : action.icon}
            label={action.disabledReason ? `${action.label}. ${action.disabledReason}` : action.label}
            className={isConfirmed ? "chat-action-button--confirmed" : undefined}
            pressed={action.pressed}
            {...(action.expanded !== undefined ? { "aria-expanded": action.expanded, "aria-haspopup": "dialog" as const } : {})}
            busy={action.busy}
            disabled={action.disabled}
            data-action-id={action.id}
            {...action.data}
            onClick={(event) => action.run(event.currentTarget)}
          />
        );
      })}
      {menuEntries.length > 0 && (
        <Menu
          label={moreLabel}
          align="end"
          className="chat-action-menu"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          entries={menuEntries}
        >
          {(trigger) => (
            <ChatActionButton
              {...trigger}
              icon={menuConfirmed ? CheckIcon : MoreIcon}
              label={moreLabel}
              className={["chat-action-more", menuConfirmed ? "chat-action-button--confirmed" : ""].filter(Boolean).join(" ")}
            />
          )}
        </Menu>
      )}
      {headless.length > 0 && (
        <span className="chat-action-headless" hidden>
          {headless.map((actionId) => packageView(actionId, "menu"))}
        </span>
      )}
    </div>
  );
}
