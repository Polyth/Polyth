// Settings editor for one role's quick actions. User messages and agent
// replies render this same section, so both are configured identically: a
// live preview, a master switch, how the bar reveals on a computer and on
// touch, and one ordered list where each action sits on the bar, in the More
// menu, or is off. Package buttons are rows of that list too.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { tr } from "../../i18n/index.ts";
import {
  ASSISTANT_MESSAGE_ACTIONS_DEFAULT,
  cloneMessageActionLayout,
  isPackageMessageActionId,
  moveMessageAction,
  resolveMessageActions,
  sameMessageActionLayout,
  setMessageActionPlacement,
  USER_MESSAGE_ACTIONS_DEFAULT,
  withPackageMessageActions,
  type MessageActionId,
  type MessageActionLayout,
  type MessageActionPlacement,
  type MessageActionReveal,
  type MessageActionRole,
  type MessageActionTouchReveal,
  type WithPackageActions,
} from "../../messageActionLayout.ts";
import { setUiSettings, useUiSettings } from "../../uiPrefs.ts";
import { MESSAGE_ACTION_ICONS, messageActionDescription, messageActionName } from "../messageActionCatalog.ts";
import { useMessageActionContributions, type MessageActionContribution } from "../messageActionContributions.ts";
import { useTouchPointer } from "../MessageActionBar.tsx";
import { DragHandleIcon, Icon, MoreIcon, PluginIcon, PointerIcon, type LucideIcon } from "../ui/index.ts";
import { ResetLink, Row, Section, Seg, Toggle } from "./parts.tsx";
import "./MessageActionsEditor.css";

type PreviewDevice = "computer" | "touch";
type ActionKey = WithPackageActions<MessageActionId>;

/** How one row reads: built-in actions from the catalog, package buttons from
 *  their contribution (or their id while the package is off). */
interface RowInfo {
  name: string;
  icon: LucideIcon;
  description: string;
  /** Its package is off or gone: the row keeps its slot but shows nothing. */
  unavailable: boolean;
  /** Bar-only package buttons offer no "Menu" placement. */
  menu: boolean;
}

function rowInfo(
  role: MessageActionRole,
  id: ActionKey,
  contributions: ReadonlyMap<string, MessageActionContribution>,
): RowInfo {
  if (!isPackageMessageActionId(id)) {
    return {
      name: messageActionName(id),
      icon: MESSAGE_ACTION_ICONS[id],
      description: messageActionDescription(role, id),
      unavailable: false,
      menu: true,
    };
  }
  const entry = contributions.get(id);
  const fallback = id.slice("pkg:".length).split(/[._:-]+/).filter(Boolean).join(" ");
  return {
    name: entry?.label ?? fallback,
    icon: entry?.icon ?? PluginIcon,
    description: entry?.description ?? tr("settings.quickActions.packageAction"),
    unavailable: !entry,
    menu: entry?.menu === true,
  };
}

function roleState(role: MessageActionRole, ui: ReturnType<typeof useUiSettings>) {
  return role === "user"
    ? {
      show: ui.showMessageActions,
      layout: ui.userMessageActions as MessageActionLayout<ActionKey>,
      defaults: USER_MESSAGE_ACTIONS_DEFAULT as MessageActionLayout<ActionKey>,
    }
    : {
      show: ui.showAnswerQuickActions,
      layout: ui.assistantMessageActions as MessageActionLayout<ActionKey>,
      defaults: ASSISTANT_MESSAGE_ACTIONS_DEFAULT as MessageActionLayout<ActionKey>,
    };
}

function writeRole(role: MessageActionRole, patch: { show?: boolean; layout?: MessageActionLayout<ActionKey> }): void {
  if (role === "user") {
    setUiSettings({
      ...(patch.show !== undefined ? { showMessageActions: patch.show } : {}),
      ...(patch.layout ? { userMessageActions: patch.layout as typeof USER_MESSAGE_ACTIONS_DEFAULT } : {}),
    });
    return;
  }
  setUiSettings({
    ...(patch.show !== undefined ? { showAnswerQuickActions: patch.show } : {}),
    ...(patch.layout ? { assistantMessageActions: patch.layout as typeof ASSISTANT_MESSAGE_ACTIONS_DEFAULT } : {}),
  });
}

export default function MessageActionsEditor({ role, itemId }: { role: MessageActionRole; itemId: string }) {
  const ui = useUiSettings();
  const touchPointer = useTouchPointer();
  const [device, setDevice] = useState<PreviewDevice>(touchPointer ? "touch" : "computer");
  const contributions = useMessageActionContributions(role);
  const { show, layout: stored, defaults } = roleState(role, ui);
  const layout = withPackageMessageActions(stored, contributions);
  const byPackage = new Map<string, MessageActionContribution>(contributions.map((entry) => [entry.id, entry]));
  const setLayout = (next: MessageActionLayout<ActionKey>) => writeRole(role, { layout: next });
  const info = (id: ActionKey) => rowInfo(role, id, byPackage);
  const isDefault = show && sameMessageActionLayout(stored, defaults);

  return (
    <Section
      title={role === "user" ? tr("settings.quickActions.userTitle") : tr("settings.quickActions.assistantTitle")}
      hint={role === "user" ? tr("settings.quickActions.userHint") : tr("settings.quickActions.assistantHint")}
      itemId={itemId}
      action={(
        <ResetLink
          disabled={isDefault}
          onClick={() => writeRole(role, { show: true, layout: cloneMessageActionLayout(defaults) })}
        />
      )}
    >
      <ActionPreview
        role={role}
        layout={layout}
        show={show}
        device={device}
        onDevice={setDevice}
        info={info}
      />
      <Row label={tr("settings.quickActions.show")} hint={tr("settings.quickActions.showHint")}>
        <Toggle on={show} onChange={(next) => writeRole(role, { show: next })} label={tr("settings.quickActions.show")} />
      </Row>
      <Row label={tr("settings.quickActions.computer")} hint={tr("settings.quickActions.computerHint")} disabled={!show}>
        <Seg<MessageActionReveal>
          label={tr("settings.quickActions.computer")}
          value={layout.reveal}
          disabled={!show}
          options={[
            ["always", tr("settings.quickActions.always")],
            ["hover", tr("settings.quickActions.hover")],
            ["menu", tr("settings.quickActions.menuOnly")],
          ]}
          onChange={(reveal) => {
            setDevice("computer");
            setLayout({ ...layout, reveal });
          }}
        />
      </Row>
      <Row label={tr("settings.quickActions.touch")} hint={tr("settings.quickActions.touchHint")} disabled={!show}>
        <Seg<MessageActionTouchReveal>
          label={tr("settings.quickActions.touch")}
          value={layout.touch}
          disabled={!show}
          options={[
            ["always", tr("settings.quickActions.always")],
            ["menu", tr("settings.quickActions.menuOnly")],
          ]}
          onChange={(touch) => {
            setDevice("touch");
            setLayout({ ...layout, touch });
          }}
        />
      </Row>
      <Row label={tr("settings.quickActions.buttons")} hint={tr("settings.quickActions.buttonsHint")} layout="stacked" disabled={!show}>
        <ActionList
          layout={layout}
          disabled={!show}
          info={info}
          onChange={setLayout}
        />
      </Row>
    </Section>
  );
}

function ActionPreview({ role, layout, show, device, onDevice, info }: {
  role: MessageActionRole;
  layout: MessageActionLayout<ActionKey>;
  show: boolean;
  device: PreviewDevice;
  onDevice: (device: PreviewDevice) => void;
  info: (id: ActionKey) => RowInfo;
}) {
  const resolved = resolveMessageActions(
    layout,
    (id) => !info(id).unavailable,
    device === "touch",
    (id) => info(id).menu,
  );
  const empty = resolved.bar.length === 0 && resolved.menu.length === 0;
  const caption = !show
    ? tr("settings.quickActions.previewOff")
    : empty
      ? tr("settings.quickActions.previewEmpty")
      : resolved.mode === "hover"
        ? tr("settings.quickActions.previewHover")
        : resolved.mode === "menu"
          ? tr("settings.quickActions.previewMenu")
          : tr("settings.quickActions.previewAlways");
  const bar = show && !empty && (
    <span className="mqa-preview-bar" data-reveal={resolved.mode}>
      {resolved.bar.map((id) => (
        <span key={id} className="mqa-preview-btn">
          <Icon icon={info(id).icon} size="sm" />
        </span>
      ))}
      {resolved.menu.length > 0 && (
        <span className="mqa-preview-btn mqa-preview-more">
          <Icon icon={MoreIcon} size="sm" />
        </span>
      )}
      {resolved.mode === "hover" && device === "computer" && (
        <span className="mqa-preview-cursor"><Icon icon={PointerIcon} size="sm" /></span>
      )}
    </span>
  );
  return (
    <div className="mqa-preview" data-role={role} data-device={device}>
      <div className="mqa-preview-head">
        <span className="mqa-preview-title">{tr("settings.quickActions.preview")}</span>
        <Seg<PreviewDevice>
          label={tr("settings.quickActions.previewDevice")}
          value={device}
          options={[
            ["computer", tr("settings.quickActions.previewComputer")],
            ["touch", tr("settings.quickActions.previewTouch")],
          ]}
          onChange={onDevice}
        />
      </div>
      <div className="mqa-preview-stage" aria-hidden="true">
        {role === "user" ? (
          <div className="mqa-preview-message mqa-preview-message--user">
            <div className="mqa-preview-bubble">{tr("settings.quickActions.sampleUser")}</div>
            <div className="mqa-preview-meta">
              <span className="mqa-preview-time">12:41</span>
              {bar}
            </div>
          </div>
        ) : (
          <div className="mqa-preview-message mqa-preview-message--assistant">
            <span className="mqa-preview-line" style={{ inlineSize: "92%" }} />
            <span className="mqa-preview-line" style={{ inlineSize: "78%" }} />
            <span className="mqa-preview-line" style={{ inlineSize: "54%" }} />
            <div className="mqa-preview-meta">
              <span className="mqa-preview-identity">
                <span className="mqa-preview-logo" />
                {tr("settings.quickActions.sampleAgent")}
              </span>
              {bar}
            </div>
          </div>
        )}
        {show && resolved.menu.length > 0 && (
          <div className="mqa-preview-menu">
            {resolved.menu.map((id) => (
              <span key={id} className="mqa-preview-menu-item">
                <Icon icon={info(id).icon} size="sm" />
                <span>{info(id).name}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <p className="mqa-preview-caption" aria-live="polite">{caption}</p>
    </div>
  );
}

function ActionList({ layout, disabled, info, onChange }: {
  layout: MessageActionLayout<ActionKey>;
  disabled: boolean;
  info: (id: ActionKey) => RowInfo;
  onChange: (next: MessageActionLayout<ActionKey>) => void;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const [dragging, setDragging] = useState<ActionKey | null>(null);
  const [status, setStatus] = useState("");
  // Latest layout for pointer moves that land between renders.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const moveTo = (id: ActionKey, index: number, announce: boolean) => {
    const current = layoutRef.current;
    const from = current.items.findIndex((item) => item.id === id);
    const target = Math.max(0, Math.min(current.items.length - 1, index));
    if (from < 0 || from === target) return;
    const next = moveMessageAction(current, id, target);
    layoutRef.current = next;
    onChange(next);
    if (announce) {
      setStatus(tr("settings.quickActions.moved", { action: info(id).name, position: target + 1, total: next.items.length }));
    }
  };

  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: ActionKey, index: number) => {
    const last = layout.items.length - 1;
    const target = event.key === "ArrowUp" ? index - 1
      : event.key === "ArrowDown" ? index + 1
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (target === null) return;
    event.preventDefault();
    moveTo(id, target, true);
    // The row re-renders at its new index; keep focus on its handle.
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLButtonElement>(`[data-action-handle="${id}"]`)?.focus();
    });
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, id: ActionKey) => {
    if (disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    setDragging(id);
  };

  // Track the drag on the window: reordering moves the row's DOM node, which
  // would drop a pointer capture held by its handle mid-gesture.
  useEffect(() => {
    if (!dragging) return;
    const id = dragging;
    const onMove = (event: globalThis.PointerEvent) => {
      if (!listRef.current) return;
      // Target = how many other rows sit above the pointer.
      const rows = Array.from(listRef.current.querySelectorAll<HTMLElement>(":scope > li"))
        .filter((row) => row.dataset.actionId !== id);
      const index = rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top + rect.height / 2 < event.clientY;
      }).length;
      moveTo(id, index, false);
    };
    const onEnd = () => {
      setDragging(null);
      const current = layoutRef.current;
      const index = current.items.findIndex((item) => item.id === id);
      setStatus(tr("settings.quickActions.moved", { action: info(id).name, position: index + 1, total: current.items.length }));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  // moveTo reads the latest layout through layoutRef.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  return (
    <>
      <ol ref={listRef} className="mqa-list" data-dragging={dragging ? "true" : undefined}>
        {layout.items.map((item, index) => {
          const row = info(item.id);
          const name = row.name;
          // A bar-only button reads its stored "menu" placement as the bar,
          // where it actually renders.
          const placement = !row.menu && item.placement === "menu" ? "bar" : item.placement;
          const detail = row.unavailable
            ? tr("settings.quickActions.packageOff")
            : row.menu
              ? row.description
              : `${row.description} ${tr("settings.quickActions.barOnly")}`;
          return (
            <li
              key={item.id}
              className="mqa-item"
              data-action-id={item.id}
              data-placement={placement}
              data-dragging={dragging === item.id ? "true" : undefined}
            >
              <button
                type="button"
                className="mqa-handle"
                data-action-handle={item.id}
                aria-label={tr("settings.quickActions.reorder", { action: name })}
                title={tr("settings.quickActions.reorder", { action: name })}
                disabled={disabled}
                onKeyDown={(event) => onHandleKeyDown(event, item.id, index)}
                onPointerDown={(event) => onPointerDown(event, item.id)}
              >
                <Icon icon={DragHandleIcon} size="sm" />
              </button>
              <span className="mqa-item-glyph"><Icon icon={row.icon} size="md" /></span>
              <span className="mqa-item-copy">
                <span className="mqa-item-name">{name}</span>
                <span className="mqa-item-detail">{detail}</span>
              </span>
              <span className="mqa-item-placement">
                <Seg<MessageActionPlacement>
                  label={tr("settings.quickActions.placement", { action: name })}
                  value={placement}
                  disabled={disabled}
                  options={[
                    ["bar", tr("settings.quickActions.placeBar")],
                    ...(row.menu ? [["menu", tr("settings.quickActions.placeMenu")] as [MessageActionPlacement, string]] : []),
                    ["off", tr("settings.quickActions.placeOff")],
                  ]}
                  onChange={(placement) => onChange(setMessageActionPlacement(layout, item.id, placement))}
                />
              </span>
            </li>
          );
        })}
      </ol>
      <span className="mqa-status" role="status">{status}</span>
    </>
  );
}
