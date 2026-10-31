// The phone Workspace in edit mode: the arrangement drawn the way it will
// look — app tiles flowing several to a line, widgets and layout elements as
// full-width rows — with every way to manage it on the item itself:
//   * drag to reorder (workspaceArrange.ts): long-press anywhere, or grab a
//     row's grip for an instant pick-up; arrow keys on a tile or grip;
//   * the corner minus removes (the item shrinks away, the rest closes up);
//   * a widget's size pill cycles its sizes; headings and labelled dividers
//     are edited in place;
//   * Undo walks back every change of this editing session.
// Adding is a page of its own (WorkspaceGallery.tsx), opened from the card at
// the top. Rows show metadata only — a live widget never renders in here.
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { confirmAlert } from "../../alerts.ts";
import { hapticFeedback, selectionFeedback } from "../../haptics.ts";
import { tr } from "../../i18n/index.ts";
import { motionIsReduced } from "../../motionPresence.ts";
import { useArrange, type ArrangeEngine, type ArrangeItem } from "../../workspaceArrange.ts";
import {
  panelItemLabel,
  permutePanelItems,
  removePanelItem,
  updatePanelItem,
  type PanelItemDefinition,
  type PanelItemInstance,
  type WorkspacePanelLayout,
} from "../../workspacePanel.ts";
import {
  Button,
  ChevronRightIcon,
  DragHandleIcon,
  Icon,
  LayersIcon,
  MinusIcon,
  PlusIcon,
  RefreshIcon,
  UndoIcon,
} from "../ui/index.ts";
import { PANEL_SIZE_LABELS, PanelItemGlyph } from "./WorkspaceGallery.tsx";

/** How long a removed item takes to shrink away before the rest closes up. */
const REMOVE_EXIT_MS = 150;

interface EditorActions {
  remove(id: string): void;
  cycleSize(id: string): void;
  setLabel(id: string, label: string): void;
}

function itemName(item: PanelItemInstance, definition: PanelItemDefinition): string {
  return panelItemLabel(item) || definition.title;
}

const EditorItem = memo(function EditorItem({ item, definition, hole, fresh, engine, actions, keyboardHintId }: {
  item: PanelItemInstance;
  definition: PanelItemDefinition;
  hole: boolean;
  fresh: boolean;
  engine: ArrangeEngine;
  actions: EditorActions;
  keyboardHintId: string;
}) {
  const name = itemName(item, definition);
  const className = `workspace-editor-item workspace-editor-item--${definition.type}${hole ? " is-hole" : ""}${fresh ? " is-fresh" : ""}`;
  const remove = (
    <button
      type="button"
      className="workspace-editor-remove"
      data-arrange-control=""
      aria-label={tr("workspace.panel.removeValue", { value: name })}
      onClick={() => actions.remove(item.id)}
    >
      <Icon icon={MinusIcon} size="sm" />
    </button>
  );
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target === event.currentTarget && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      actions.remove(item.id);
      return;
    }
    engine.onArrangeKey(item.id, event);
  };

  if (definition.type === "launcher") {
    return (
      <li
        className={className}
        {...engine.itemProps(item.id)}
        tabIndex={0}
        aria-label={name}
        aria-describedby={keyboardHintId}
        onKeyDown={onKeyDown}
      >
        {remove}
        <span className="workspace-editor-tile-icon" aria-hidden="true"><PanelItemGlyph definition={definition} /></span>
        <span className="workspace-editor-tile-label">{definition.title}</span>
      </li>
    );
  }

  const grip = (
    <button
      type="button"
      className="workspace-editor-grip"
      {...engine.gripProps(item.id)}
      aria-label={tr("workspace.panel.moveValue", { value: name })}
      aria-describedby={keyboardHintId}
      onKeyDown={onKeyDown}
    >
      <Icon icon={DragHandleIcon} />
    </button>
  );
  const label = panelItemLabel(item);

  if (definition.type === "widget") {
    const sizeLabel = tr(PANEL_SIZE_LABELS[item.size]);
    return (
      <li className={className} {...engine.itemProps(item.id)}>
        {remove}
        <span className="workspace-editor-row-icon" aria-hidden="true"><PanelItemGlyph definition={definition} /></span>
        <span className="workspace-editor-row-copy">
          <strong>{definition.title}</strong>
          <small>{definition.description}</small>
        </span>
        {definition.supportedSizes.length > 1 && (
          <button
            type="button"
            className="workspace-editor-size"
            data-arrange-control=""
            aria-label={tr("workspace.panel.sizeValue", { value: definition.title, size: sizeLabel })}
            onClick={() => actions.cycleSize(item.id)}
          >
            <span key={item.size}>{sizeLabel}</span>
          </button>
        )}
        {grip}
      </li>
    );
  }

  if (definition.type === "header") {
    return (
      <li className={className} {...engine.itemProps(item.id)}>
        {remove}
        <input
          className="workspace-editor-label workspace-editor-label--heading"
          data-arrange-control=""
          value={label}
          placeholder={tr("workspace.panel.headingPlaceholder")}
          aria-label={tr("workspace.panel.headingLabel")}
          enterKeyHint="done"
          onChange={(event) => actions.setLabel(item.id, event.target.value)}
        />
        {grip}
      </li>
    );
  }

  return (
    <li className={className} {...engine.itemProps(item.id)}>
      {remove}
      <span className="workspace-editor-rule">
        <i aria-hidden="true" />
        {definition.type === "labeled-divider" ? (
          <input
            className="workspace-editor-label"
            data-arrange-control=""
            value={label}
            placeholder={tr("workspace.panel.sectionPlaceholder")}
            aria-label={tr("workspace.panel.dividerLabel")}
            enterKeyHint="done"
            onChange={(event) => actions.setLabel(item.id, event.target.value)}
          />
        ) : <span>{definition.title}</span>}
        <i aria-hidden="true" />
      </span>
      {grip}
    </li>
  );
});

/** Shrink an item away, then report back (at once with motion off). */
function playRemoval(element: HTMLElement | null, done: () => void): void {
  if (!element || motionIsReduced() || typeof element.animate !== "function") {
    done();
    return;
  }
  element.dataset.leaving = "true";
  const animation = element.animate(
    [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.86)" }],
    { duration: REMOVE_EXIT_MS, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
  );
  let finished = false;
  const once = () => {
    if (finished) return;
    finished = true;
    done();
  };
  animation.addEventListener("finish", once);
  animation.addEventListener("cancel", once);
  window.setTimeout(once, REMOVE_EXIT_MS + 80);
}

export interface WorkspaceEditorProps {
  layout: WorkspacePanelLayout;
  definitions: ReadonlyMap<string, PanelItemDefinition>;
  /** Everything the Add page offers. */
  catalogSize: number;
  /** Added on the Add page just now: marked once when the editor shows again. */
  freshIds: ReadonlySet<string>;
  /** The Add page covers the editor. */
  covered: boolean;
  canUndo: boolean;
  canReset: boolean;
  /** The sheet: where the lifted copy and the Undo control are drawn. */
  host: HTMLElement | null;
  addButtonRef: RefObject<HTMLButtonElement | null>;
  onOpenGallery: () => void;
  /** `record` false skips the undo history; a string coalesces a burst (typing). */
  onCommit: (next: WorkspacePanelLayout, message?: string, record?: boolean | string) => void;
  onUndo: () => void;
  onReset: () => void;
}

export default function WorkspaceEditor({
  layout,
  definitions,
  catalogSize,
  freshIds,
  covered,
  canUndo,
  canReset,
  host,
  addButtonRef,
  onOpenGallery,
  onCommit,
  onUndo,
  onReset,
}: WorkspaceEditorProps) {
  const keyboardHintId = useId();
  const grid = useRef<HTMLUListElement | null>(null);
  // Where a held item would land, spoken as it moves. Kept here so a move
  // renders only the editor, in the same pass as the hole.
  const [dragMessage, setDragMessage] = useState("");
  const latest = useRef({ layout, definitions, onCommit });
  latest.current = { layout, definitions, onCommit };

  // Items this device can draw; the rest keep their slots (permutePanelItems).
  const visible = useMemo(
    () => layout.items.filter((item) => definitions.has(item.definitionId)),
    [definitions, layout],
  );
  const byId = useMemo(() => new Map(visible.map((item) => [item.id, item])), [visible]);
  const arrangeItems = useMemo<ArrangeItem[]>(
    () => visible.map((item) => ({ id: item.id, shape: item.type === "launcher" ? "tile" : "row" })),
    [visible],
  );
  const nameOf = (id: string): string => {
    const item = latest.current.layout.items.find((entry) => entry.id === id);
    const definition = item ? latest.current.definitions.get(item.definitionId) : undefined;
    return item && definition ? itemName(item, definition) : "";
  };

  const { engine, order, draggingId } = useArrange({
    items: arrangeItems,
    enabled: !covered,
    scroller: () => grid.current?.closest<HTMLElement>(".sheet-body") ?? null,
    ghostHost: () => host,
    onCommit: (next, id) => latest.current.onCommit(
      permutePanelItems(latest.current.layout, next),
      tr("workspace.panel.movedValue", { value: nameOf(id), position: next.indexOf(id) + 1, count: next.length }),
    ),
    onMove: (id, index, count) => setDragMessage(
      tr("workspace.panel.movedValue", { value: nameOf(id), position: index + 1, count }),
    ),
  });

  const listRef = useCallback((element: HTMLUListElement | null) => {
    grid.current = element;
    engine.listRef(element);
  }, [engine]);

  // One stable object, so memoized rows skip renders while a drag moves the hole.
  const actions = useMemo<EditorActions>(() => ({
    remove(id) {
      const element = [...grid.current?.querySelectorAll<HTMLElement>("[data-arrange-id]") ?? []]
        .find((node) => node.dataset.arrangeId === id) ?? null;
      if (element?.dataset.leaving) return;
      const name = nameOf(id);
      playRemoval(element, () => {
        engine.animateNextLayout();
        latest.current.onCommit(removePanelItem(latest.current.layout, id), tr("workspace.panel.removedValue", { value: name }));
        hapticFeedback("tap");
      });
    },
    cycleSize(id) {
      const current = latest.current.layout;
      const item = current.items.find((entry) => entry.id === id);
      const definition = item ? latest.current.definitions.get(item.definitionId) : undefined;
      if (!item || !definition || definition.supportedSizes.length < 2) return;
      const at = Math.max(0, definition.supportedSizes.indexOf(item.size));
      const size = definition.supportedSizes[(at + 1) % definition.supportedSizes.length]!;
      latest.current.onCommit(
        updatePanelItem(current, id, { size }),
        tr("workspace.panel.sizeChangedValue", { value: definition.title, size: tr(PANEL_SIZE_LABELS[size]) }),
      );
      selectionFeedback();
    },
    setLabel(id, label) {
      const current = latest.current.layout;
      const item = current.items.find((entry) => entry.id === id);
      if (!item) return;
      latest.current.onCommit(updatePanelItem(current, id, { config: { ...item.config, label } }), undefined, `label:${id}`);
    },
  }), [engine]);

  // Back from the Add page: bring the first newcomer into view.
  useEffect(() => {
    if (covered || freshIds.size === 0) return;
    const element = [...grid.current?.querySelectorAll<HTMLElement>("[data-arrange-id]") ?? []]
      .find((node) => freshIds.has(node.dataset.arrangeId ?? ""));
    element?.scrollIntoView?.({ block: "nearest", behavior: motionIsReduced() ? "auto" : "smooth" });
  }, [covered, freshIds]);

  const undo = () => {
    engine.animateNextLayout();
    onUndo();
  };
  const reset = async () => {
    const confirmed = await confirmAlert(tr("workspace.panel.resetConfirm"), {
      title: tr("workspace.panel.resetConfirmTitle"),
      confirmLabel: tr("workspace.panel.resetAction"),
      destructive: true,
    });
    if (!confirmed) return;
    engine.animateNextLayout();
    onReset();
  };

  return (
    <div className="workspace-editor" inert={covered || undefined}>
      <button type="button" className="workspace-editor-add" ref={addButtonRef} onClick={onOpenGallery}>
        <span className="workspace-editor-add-icon" aria-hidden="true"><Icon icon={PlusIcon} size="lg" /></span>
        <span className="workspace-editor-add-copy">
          <strong>{tr("workspace.panel.addTitle")}</strong>
          <small>{tr("workspace.panel.availableValue", { count: catalogSize })}</small>
        </span>
        <Icon icon={ChevronRightIcon} className="workspace-editor-add-chevron" />
      </button>

      {visible.length > 0 ? (
        <p className="workspace-editor-hint">{tr("workspace.panel.arrangeHint")}</p>
      ) : (
        <div className="workspace-editor-empty">
          <span className="workspace-editor-empty-icon" aria-hidden="true"><Icon icon={LayersIcon} size="xl" /></span>
          <strong>{tr("workspace.panel.emptyTitle")}</strong>
          <p>{tr("workspace.panel.emptyDetail")}</p>
        </div>
      )}
      <span className="sr-only" id={keyboardHintId}>{tr("workspace.panel.keyboardHint")}</span>
      <span className="sr-only" role="status" aria-live="polite">{dragMessage}</span>

      <ul
        className="workspace-editor-grid"
        ref={listRef}
        aria-label={tr("workspace.panel.arrangementLabel")}
        data-arranging={draggingId ? "" : undefined}
      >
        {order.map((id) => {
          const item = byId.get(id);
          const definition = item ? definitions.get(item.definitionId) : undefined;
          if (!item || !definition) return null;
          return (
            <EditorItem
              key={id}
              item={item}
              definition={definition}
              hole={draggingId === id}
              fresh={freshIds.has(id)}
              engine={engine}
              actions={actions}
              keyboardHintId={keyboardHintId}
            />
          );
        })}
      </ul>

      <div className="workspace-editor-footer">
        <Button variant="ghost" size="sm" iconStart={RefreshIcon} disabled={!canReset} onClick={() => { void reset(); }}>
          {tr("workspace.panel.reset")}
        </Button>
      </div>

      {host && canUndo && !covered && createPortal(
        <button type="button" className="workspace-editor-undo" onClick={undo}>
          <Icon icon={UndoIcon} size="sm" />
          <span>{tr("workspace.panel.undo")}</span>
        </button>,
        host,
      )}
    </div>
  );
}
