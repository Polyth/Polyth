// Owner-supplied change highlighting (EditorSurfaceProps.changes), drawn the
// way review editors do: changed lines tinted with their owner's colour, the
// removed text shown in place as a red block, a colour bar per change in the
// gutter and inline Undo/Keep actions. The owner (Files) decides who changed
// what; this module only draws it and maps it through later typing.
import { RangeSet, StateEffect, StateField, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, type DecorationSet } from "@codemirror/view";
import type { EditorChangeSet, EditorChangeTone } from "../../../apps/web/src/resources/views.ts";

type Action = "undo" | "keep" | "inspect";
type OnAction = NonNullable<EditorChangeSet["onAction"]>;

interface ChangeMarks {
  key: string | null;
  deco: DecorationSet;
  bars: RangeSet<GutterMarker>;
}

const NEUTRAL: EditorChangeTone = { color: "var(--muted)", label: "", attributed: false };
const EMPTY: ChangeMarks = { key: null, deco: Decoration.none, bars: RangeSet.empty };
/** Removed blocks longer than this collapse the rest into one summary row. */
export const MAX_REMOVED_LINES = 60;

export const setChangeMarks = StateEffect.define<EditorChangeSet | null>();

const toneStyle = (tone: EditorChangeTone): string => `--change-tone: ${tone.color}`;

function actionButton(label: string, action: Action, hunkId: string, onAction: OnAction): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-change-action";
  button.dataset.action = action;
  button.textContent = label;
  // Keep the caret where it is; the click alone acts.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onAction(hunkId, action);
  });
  return button;
}

interface ActionSpec {
  hunkId: string;
  labels: NonNullable<EditorChangeSet["actions"]>;
  onAction: OnAction;
  /** Who made the hunk, named in the chips' tooltips. */
  label: string;
  /** A hunk several owners share gets neutral chips: Undo reverts them all. */
  mixed: boolean;
}

function actionGroup(spec: ActionSpec): HTMLElement {
  const group = document.createElement("span");
  group.className = `cm-change-actions${spec.mixed ? " cm-change-actions-mixed" : ""}`;
  group.setAttribute("role", "group");
  if (spec.label) group.setAttribute("aria-label", spec.label);
  const undo = actionButton(spec.labels.undo, "undo", spec.hunkId, spec.onAction);
  const keep = actionButton(spec.labels.keep, "keep", spec.hunkId, spec.onAction);
  if (spec.label) {
    undo.title = `${spec.labels.undo} · ${spec.label}`;
    keep.title = `${spec.labels.keep} · ${spec.label}`;
  }
  group.append(undo, keep);
  return group;
}

class ActionsWidget extends WidgetType {
  private readonly spec: ActionSpec;
  constructor(spec: ActionSpec) {
    super();
    this.spec = spec;
  }
  eq(other: WidgetType): boolean {
    return other instanceof ActionsWidget && other.spec.hunkId === this.spec.hunkId
      && other.spec.labels.undo === this.spec.labels.undo && other.spec.labels.keep === this.spec.labels.keep
      && other.spec.label === this.spec.label && other.spec.mixed === this.spec.mixed
      && other.spec.onAction === this.spec.onAction;
  }
  toDOM(): HTMLElement { return actionGroup(this.spec); }
}

class RemovedWidget extends WidgetType {
  readonly lines: readonly string[];
  readonly tone: EditorChangeTone;
  readonly moreLabel: string;
  readonly actions: ActionSpec | null;
  readonly marker: GutterMarker;
  constructor(lines: readonly string[], tone: EditorChangeTone, moreLabel: string, actions: ActionSpec | null, marker: GutterMarker) {
    super();
    this.lines = lines;
    this.tone = tone;
    this.moreLabel = moreLabel;
    this.actions = actions;
    this.marker = marker;
  }
  eq(other: WidgetType): boolean {
    return other instanceof RemovedWidget
      && other.tone.color === this.tone.color && other.tone.label === this.tone.label
      && other.moreLabel === this.moreLabel
      && (other.actions?.hunkId ?? null) === (this.actions?.hunkId ?? null)
      && other.actions?.onAction === this.actions?.onAction
      && other.lines.length === this.lines.length && other.lines.every((line, index) => line === this.lines[index]);
  }
  toDOM(): HTMLElement {
    const block = document.createElement("div");
    block.className = "cm-change-removed";
    block.setAttribute("style", toneStyle(this.tone));
    if (this.tone.label) block.title = this.tone.label;
    const shown = this.lines.length > MAX_REMOVED_LINES ? this.lines.slice(0, MAX_REMOVED_LINES - 1) : this.lines;
    for (const text of shown) {
      const row = document.createElement("div");
      row.className = "cm-change-removed-line";
      row.textContent = text || "​";
      block.append(row);
    }
    if (shown.length < this.lines.length) {
      const more = document.createElement("div");
      more.className = "cm-change-removed-line cm-change-removed-more";
      more.textContent = this.moreLabel.replace("{count}", String(this.lines.length - shown.length));
      block.append(more);
    }
    if (this.actions) block.append(actionGroup(this.actions));
    return block;
  }
  get estimatedHeight(): number { return -1; }
}

class ChangeBar extends GutterMarker {
  readonly tone: EditorChangeTone;
  readonly hunkId: string;
  readonly removal: boolean;
  readonly label: string;
  readonly onAction: OnAction | null;
  constructor(tone: EditorChangeTone, hunkId: string, removal: boolean, label: string, onAction: OnAction | null) {
    super();
    this.tone = tone;
    this.hunkId = hunkId;
    this.removal = removal;
    this.label = label;
    this.onAction = onAction;
  }
  eq(other: GutterMarker): boolean {
    return other instanceof ChangeBar && other.tone.color === this.tone.color && other.hunkId === this.hunkId
      && other.removal === this.removal && other.label === this.label && other.onAction === this.onAction;
  }
  toDOM(): Node {
    const bar = document.createElement(this.onAction ? "button" : "span");
    bar.className = `cm-change-bar${this.removal ? " cm-change-bar-removed" : ""}${this.tone.attributed ? "" : " cm-change-bar-plain"}`;
    bar.setAttribute("style", toneStyle(this.tone));
    if (this.label) {
      bar.title = this.label;
      bar.setAttribute("aria-label", this.label);
    }
    if (bar instanceof HTMLButtonElement) {
      bar.type = "button";
      bar.tabIndex = -1;
      bar.addEventListener("mousedown", (event) => event.preventDefault());
      bar.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onAction?.(this.hunkId, "inspect");
      });
    }
    return bar;
  }
}

function lineStart(doc: Text, line: number): number {
  return doc.line(Math.min(Math.max(1, line), doc.lines)).from;
}

/** Build every mark for `set`; `doc` must equal `set.baseText`. */
export function buildChangeMarks(doc: Text, set: EditorChangeSet): ChangeMarks {
  const ranges: Range<Decoration>[] = [];
  const bars: Range<GutterMarker>[] = [];
  const toneOf = (index: number): EditorChangeTone => set.tones[index] ?? NEUTRAL;
  const moreLabel = set.labels?.moreRemoved ?? "+{count}";
  const onAction = set.onAction ?? null;
  for (const hunk of set.hunks) {
    const owners = new Set([...hunk.lines.map((entry) => entry.tone), ...hunk.removed.map((block) => block.tone)]);
    const actions: ActionSpec | null = set.actions && onAction && !hunk.plain
      ? { hunkId: hunk.id, labels: set.actions, onAction, label: hunk.label, mixed: owners.size > 1 }
      : null;
    const inspectLabel = set.actions ? `${hunk.label} · ${set.actions.inspect}` : hunk.label;
    const changed = hunk.lines.filter((entry) => entry.line >= 1 && entry.line <= doc.lines);
    for (const [index, entry] of changed.entries()) {
      const tone = toneOf(entry.tone);
      const from = doc.line(entry.line).from;
      // The line carrying the inline actions keeps room for them, so wrapped
      // code never runs underneath the chips.
      const anchor = index === 0 && actions ? " cm-change-anchor" : "";
      ranges.push(Decoration.line({
        class: `${tone.attributed ? "cm-change-line cm-change-attributed" : "cm-change-line"}${anchor}`,
        attributes: { style: toneStyle(tone) },
      }).range(from));
      bars.push(new ChangeBar(tone, hunk.id, false, inspectLabel, onAction).range(from));
    }
    // Inline actions ride the first changed line, else the first removed block.
    let actionsPlaced = false;
    if (actions && changed.length > 0) {
      const first = doc.line(changed[0]!.line);
      ranges.push(Decoration.widget({ widget: new ActionsWidget(actions), side: 1 }).range(first.to));
      actionsPlaced = true;
    }
    for (const block of hunk.removed) {
      if (block.text.length === 0) continue;
      const tone = toneOf(block.tone);
      const marker = new ChangeBar(tone, hunk.id, true, inspectLabel, onAction);
      const widget = new RemovedWidget(block.text, tone, moreLabel, actions && !actionsPlaced ? actions : null, marker);
      actionsPlaced ||= actions !== null;
      const atEnd = block.line > doc.lines;
      ranges.push(Decoration.widget({ widget, block: true, side: atEnd ? 1 : -1 })
        .range(atEnd ? doc.length : lineStart(doc, block.line)));
    }
  }
  return {
    key: set.key,
    deco: Decoration.set(ranges, true),
    bars: RangeSet.of(bars, true),
  };
}

export const changeMarksField = StateField.define<ChangeMarks>({
  create: () => EMPTY,
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value !== EMPTY) {
      next = { key: value.key, deco: value.deco.map(tr.changes), bars: value.bars.map(tr.changes) };
    }
    for (const effect of tr.effects) {
      if (effect.is(setChangeMarks)) next = effect.value ? buildChangeMarks(tr.state.doc, effect.value) : EMPTY;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
});

class Spacer extends GutterMarker {
  toDOM(): Node {
    const spacer = document.createElement("span");
    spacer.className = "cm-change-bar-spacer";
    return spacer;
  }
}

const changeGutter = gutter({
  class: "cm-change-gutter",
  markers: (view) => view.state.field(changeMarksField).bars,
  widgetMarker: (_view, widget) => widget instanceof RemovedWidget ? widget.marker : null,
  lineMarkerChange: (update) => update.startState.field(changeMarksField) !== update.state.field(changeMarksField),
  initialSpacer: () => new Spacer(),
});

// Tints are background images so the active-line highlight and the
// selection layer still show through a changed line.
const changeTheme = EditorView.baseTheme({
  ".cm-gutter.cm-change-gutter": { width: "7px", minWidth: "7px" },
  ".cm-change-gutter .cm-gutterElement": { padding: "0", display: "flex", alignItems: "stretch", justifyContent: "center" },
  ".cm-change-bar-spacer": { display: "block", width: "7px" },
  ".cm-change-bar": {
    position: "relative", display: "block", width: "3px", minWidth: "0", maxWidth: "5px",
    minHeight: "100%", padding: "0", margin: "0", border: "0",
    borderRadius: "2px", background: "var(--change-tone)", cursor: "pointer",
  },
  // A wider invisible hit area that never covers the line numbers or code.
  "button.cm-change-bar::after": { content: '""', position: "absolute", inset: "0 -2px" },
  "span.cm-change-bar": { cursor: "default" },
  ".cm-change-bar:hover, .cm-change-bar:focus-visible": { width: "5px", outline: "none" },
  ".cm-change-bar-plain": { opacity: "0.55" },
  ".cm-change-bar-removed": {
    background: "repeating-linear-gradient(180deg, var(--change-tone) 0 3px, transparent 3px 5px)",
  },
  ".cm-change-line": { position: "relative" },
  ".cm-line.cm-change-anchor": { paddingInlineEnd: "calc(var(--space-3) + 8.5em)" },
  ".cm-change-attributed": {
    backgroundImage: "linear-gradient(color-mix(in srgb, var(--change-tone) 15%, transparent), color-mix(in srgb, var(--change-tone) 15%, transparent))",
  },
  // The theme's own red wash keeps removals reading as red on light themes too.
  ".cm-change-removed": {
    position: "relative",
    backgroundColor: "var(--red-wash, color-mix(in srgb, var(--red) 16%, transparent))",
    color: "color-mix(in srgb, var(--text) 80%, transparent)",
    padding: "0 var(--space-3) 0 var(--space-2)",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  ".cm-change-removed:has(> .cm-change-actions)": { paddingInlineEnd: "calc(var(--space-3) + 8.5em)" },
  ".cm-change-removed-line": { minHeight: "1.55em" },
  ".cm-change-removed-more": { fontStyle: "italic", color: "var(--muted)" },
  ".cm-change-actions": {
    position: "absolute", insetInlineEnd: "var(--space-2)", top: "1px",
    display: "inline-flex", gap: "2px", zIndex: "1",
    fontFamily: "var(--ui-font-family)", whiteSpace: "nowrap",
  },
  ".cm-change-action": {
    position: "relative", height: "1.4em", minWidth: "0", minHeight: "0", padding: "0 7px",
    border: "1px solid var(--border-soft)", borderRadius: "var(--radius-sm, 4px)",
    background: "var(--elevated)", color: "var(--text-dim)",
    font: "500 var(--font-meta)/1 var(--ui-font-family)", cursor: "pointer",
    boxShadow: "var(--shadow-sm, none)",
  },
  // Touch gets a taller hit area without a taller chip over the code.
  "@media (pointer: coarse)": {
    ".cm-change-action::after": { content: '""', position: "absolute", inset: "-9px -2px" },
  },
  ".cm-change-action:hover, .cm-change-action:focus-visible": { color: "var(--text)", background: "var(--raised)" },
  ".cm-change-action[data-action='keep']": {
    color: "var(--text)",
    background: "color-mix(in srgb, var(--change-tone, var(--accent)) 26%, var(--elevated))",
    borderColor: "color-mix(in srgb, var(--change-tone, var(--accent)) 45%, var(--border-soft))",
  },
  ".cm-change-actions-mixed .cm-change-action[data-action='keep']": {
    background: "var(--raised)",
    borderColor: "var(--border-soft)",
  },
});

export const changeMarksExtension = [changeMarksField, changeGutter, changeTheme];

/** Current marks' identity (tests and the runtime's apply guard). */
export function changeMarksKey(state: import("@codemirror/state").EditorState): string | null {
  return state.field(changeMarksField, false)?.key ?? null;
}
