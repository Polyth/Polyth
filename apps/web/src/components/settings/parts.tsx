// Shared building blocks for settings pages. The page contract (control
// vocabulary, sections, copy, save semantics, empty/error states) lives in
// docs/dev/ui.md §4.5 "Settings page contract"; these primitives implement it
// for built-in pages and for package pages that import this module.
import {
  useEffect, useId, useState,
  type ComponentProps, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode,
} from "react";
import { readErrorDiagnostics } from "@polyth/contracts";
import Button from "../ui/Button.tsx";
import Checkbox from "../ui/Checkbox.tsx";
import CoreEmptyState from "../EmptyState.tsx";
import Icon from "../ui/Icon.tsx";
import IconButton from "../ui/IconButton.tsx";
import Spinner from "../ui/Spinner.tsx";
import Switch from "../ui/Switch.tsx";
import Tabs, { TabPanel, type TabItem } from "../ui/Tabs.tsx";
import TextInput from "../ui/TextInput.tsx";
import { ChevronRightIcon, MinusIcon, PlusIcon } from "../ui/icons.ts";
import { PackageGlyph } from "./packageIcons.tsx";
import { highlightParts } from "./textMatch.ts";
import { tr } from "../../i18n/index.ts";
import { isImeComposing } from "../input/editorCore.ts";

/** The settings glyph set (nav, item tiles), so a package `ItemRow` tile can
 *  show the same mark — `PackageGlyph({ icon: "git" })`. */
export { PackageGlyph };

/** One setting: label + one-sentence hint on the left, control on the right.
 *  `layout="stacked"` puts a full-width control under the label (textareas,
 *  long inputs, lists). `top` aligns the label to the top of a tall control. */
export function Row({ label, hint, itemId, children, layout = "inline", top = false, disabled = false }: {
  label: ReactNode;
  hint?: ReactNode;
  itemId?: string;
  children: ReactNode;
  layout?: "inline" | "stacked";
  top?: boolean;
  /** Dims the copy for a setting that has no effect right now; the control
   *  itself must still be disabled by the page. */
  disabled?: boolean;
}) {
  const className = [
    "set-row settings-row",
    layout === "stacked" ? "is-stacked" : "",
    top ? "top" : "",
    disabled ? "is-disabled" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={className} {...(itemId ? { "data-settings-item": itemId } : {})}>
      <div className="set-row-text">
        <div className="set-row-label">{label}</div>
        {hint && <div className="set-row-hint">{hint}</div>}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

/** Read-only fact (branch, version, endpoint) in Row geometry. Optional
 *  `action` (a small quiet Button) sits after the value. */
export function ReadonlyRow({ label, hint, value, mono = false, action, itemId }: {
  label: ReactNode;
  hint?: ReactNode;
  value: ReactNode;
  mono?: boolean;
  action?: ReactNode;
  itemId?: string;
}) {
  return (
    <Row label={label} {...(hint ? { hint } : {})} {...(itemId ? { itemId } : {})}>
      <span className={`set-row-value${mono ? " is-mono" : ""}`}>{value}</span>
      {action}
    </Row>
  );
}

/** A titled group of rows. The shell owns the page title; sections are the
 *  only headings inside a page. `action` is a small header control (usually
 *  `<ResetLink>`); `tone="danger"` frames destructive actions at page end. */
export function Section({ title, hint, action, itemId, tone, children }: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  itemId?: string;
  tone?: "danger";
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      className={`settings-section${tone === "danger" ? " is-danger" : ""}`}
      aria-labelledby={headingId}
      {...(itemId ? { "data-settings-item": itemId } : {})}
    >
      <div className="settings-section-head">
        <div className="settings-section-copy">
          <h3 className="settings-section-title" id={headingId}>{title}</h3>
          {hint && <p className="settings-section-hint">{hint}</p>}
        </div>
        {action && <div className="settings-section-action">{action}</div>}
      </div>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

/** `text` with every query word marked (multi-word, case-insensitive). */
export function HighlightedText({ text, query }: { text: string; query?: string }) {
  if (!query?.trim()) return <>{text}</>;
  return (
    <>
      {highlightParts(text, query).map((part, index) => part.match
        ? <mark className="settings-list-match" key={index}>{part.text}</mark>
        : part.text)}
    </>
  );
}

/** A grouped list of like items (packages, servers, accounts): one quiet
 *  surface with `ItemRow`s. Inside a `Section` it replaces a stack of `Row`s
 *  when each item has an identity (mark, name, description) and its own
 *  controls. */
export function ItemList({ label, className, children }: {
  /** Accessible name when the surrounding heading does not label the list. */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`settings-list${className ? ` ${className}` : ""}`} role="list" {...(label ? { "aria-label": label } : {})}>
      {children}
    </div>
  );
}

export interface ItemRowSelection {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name of the checkbox ("Select Git"). */
  label: string;
}

export interface ItemRowProps extends Omit<ComponentProps<"div">, "title" | "children" | "role"> {
  /** The item's mark, shown on a quiet tile. */
  icon: ReactNode;
  title: string;
  /** Short facts after the title (version, one status `Badge`). */
  meta?: ReactNode;
  description?: string;
  /** Query words to mark in the title and description. */
  highlight?: string;
  /** Row controls; end with the main control (a `Switch`) so every row's
   *  control shares one column. */
  trailing?: ReactNode;
  /** Opens the item (its detail or its own page): the whole row becomes one
   *  labelled button and a chevron marks it. */
  onOpen?: () => void;
  openLabel?: string;
  /** Selection mode: a checkbox leads the row and a click anywhere toggles it. */
  selection?: ItemRowSelection;
  /** Off / unavailable items read quieter. */
  inactive?: boolean;
  /** Inline failure for this item (refused change, start error). */
  error?: ReactNode;
  /** Inline caution shown in the same place as `error` when there is none. */
  notice?: ReactNode;
}

const ROW_CONTROL = "button, a, input, select, textarea, label, [role=switch], [role=menu], [role=dialog]";

/** One item of an `ItemList`. Mark, title (+ meta) and description on the
 *  left, controls at the trailing edge, a reserved chevron column so controls
 *  align from row to row whether or not a row opens. On a narrow list the
 *  description runs under the controls instead of squeezing beside them. */
export function ItemRow({
  icon, title, meta, description, highlight, trailing, onOpen, openLabel, selection, inactive = false, error, notice, className, ...rest
}: ItemRowProps) {
  const descriptionId = useId();
  const opens = !selection && onOpen !== undefined;
  const classes = [
    "settings-list-row",
    opens || selection ? "is-actionable" : "",
    selection ? "is-selecting" : "",
    selection?.checked ? "is-selected" : "",
    inactive ? "is-inactive" : "",
    className ?? "",
  ].filter(Boolean).join(" ");
  // In selection mode the checkbox is the one control for the row; a click on
  // the rest of the row is a pointer shortcut, not a second focus stop.
  const toggleFromRow = selection
    ? (event: MouseEvent<HTMLDivElement>) => {
        if ((event.target as Element).closest(ROW_CONTROL)) return;
        selection.onChange(!selection.checked);
      }
    : undefined;
  return (
    <div {...rest} className={classes} role="listitem" {...(toggleFromRow ? { onClick: toggleFromRow } : {})}>
      {selection && (
        <Checkbox
          className="settings-list-select"
          checked={selection.checked}
          onChange={selection.onChange}
          label={<span className="sr-only">{selection.label}</span>}
        />
      )}
      {opens && (
        <button
          type="button"
          className="settings-list-hit"
          aria-label={openLabel ?? title}
          {...(description ? { "aria-describedby": descriptionId } : {})}
          onClick={onOpen}
        />
      )}
      <span className="settings-list-tile" aria-hidden="true">{icon}</span>
      <div className="settings-list-title">
        <strong><HighlightedText text={title} {...(highlight ? { query: highlight } : {})} /></strong>
        {meta && <span className="settings-list-meta">{meta}</span>}
      </div>
      {description && (
        <p className="settings-list-desc" id={descriptionId}>
          <HighlightedText text={description} {...(highlight ? { query: highlight } : {})} />
        </p>
      )}
      {error
        ? <p className="settings-list-error" role="alert">{error}</p>
        : notice && <p className="settings-list-error settings-list-notice">{notice}</p>}
      {trailing && <div className="settings-list-trailing">{trailing}</div>}
      <span className="settings-list-chevron" aria-hidden="true">
        {opens && <Icon icon={ChevronRightIcon} size="sm" />}
      </span>
    </div>
  );
}

/** Section-header reset. Disable it when the values already equal defaults so
 *  the link never offers a no-op. */
export function ResetLink({ onClick, disabled = false, label }: { onClick: () => void; disabled?: boolean; label?: string }) {
  return (
    <Button variant="ghost" size="sm" className="settings-reset-link" disabled={disabled} onClick={onClick}>
      {label ?? tr("settings.parts.reset")}
    </Button>
  );
}

/** Labelled field for stacked forms (add/edit forms, dialogs). Pass a render
 *  function to receive `id`/`aria-describedby` for the control; a plain child
 *  is associated by wrapping it in the <label>. Never rely on placeholders as
 *  labels. */
export function FormField({ label, hint, error, optional = false, children }: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  children: ReactNode | ((field: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode);
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined;
  const labelText = (
    <span className="settings-field-label">
      {label}
      {optional && <span className="settings-field-optional">{tr("settings.parts.optional")}</span>}
    </span>
  );
  const notes = (
    <>
      {hint && <span className="settings-field-hint" id={hintId}>{hint}</span>}
      {error && <span className="settings-field-error" id={errorId} role="alert">{error}</span>}
    </>
  );
  if (typeof children === "function") {
    return (
      <div className="settings-field">
        <label htmlFor={id}>{labelText}</label>
        {children({ id, ...(describedBy ? { "aria-describedby": describedBy } : {}), ...(error ? { "aria-invalid": true as const } : {}) })}
        {notes}
      </div>
    );
  }
  return (
    <div className="settings-field">
      <label className="settings-field-wrap">
        {labelText}
        {children}
      </label>
      {notes}
    </div>
  );
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <Switch
      checked={on}
      onChange={onChange}
      className="set-toggle"
      {...(label !== undefined ? { label } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
    />
  );
}

/** Multi-select list (several independent choices of one kind). One Checkbox
 *  per option, wrapped with consistent gaps; `columns` lays long lists out in
 *  a grid on wide panes (always one column on phones). */
export function CheckGroup<T extends string>({ label, value, options, onChange, columns = 1, disabled = false }: {
  /** Accessible group name, usually the Row label. */
  label: string;
  value: readonly T[];
  options: ReadonlyArray<{ id: T; label: ReactNode; description?: ReactNode; disabled?: boolean }>;
  onChange: (next: T[]) => void;
  columns?: 1 | 2 | 3;
  disabled?: boolean;
}) {
  const selected = new Set(value);
  return (
    <div
      className="settings-check-group"
      role="group"
      aria-label={label}
      style={{ "--settings-check-columns": columns } as CSSProperties}
    >
      {options.map((option) => (
        <Checkbox
          key={option.id}
          checked={selected.has(option.id)}
          disabled={disabled || option.disabled === true}
          label={option.label}
          {...(option.description ? { description: option.description } : {})}
          onChange={(checked) => {
            const next = options
              .map((entry) => entry.id)
              .filter((id) => (id === option.id ? checked : selected.has(id)));
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}

/** One number with an adjoining unit. Edits are a local draft; the value is
 *  clamped/stepped and committed on blur or Enter (Escape reverts), so
 *  clearing the field never persists 0. */
export function NumberField({ value, onCommit, label, unit, min, max, step = 1, disabled = false, width = "sm" }: {
  value: number;
  onCommit: (value: number) => void;
  /** Accessible name; the Row label when used inside a Row. */
  label: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** sm ≈ 4 digits, md ≈ 8 digits. */
  width?: "sm" | "md";
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const parsed = Number(draft.trim());
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    let next = Math.round(parsed / step) * step;
    // Round away float noise from the step multiplication (0.1 * 3).
    next = Number(next.toFixed(6));
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape" && draft !== String(value)) {
      // Revert the draft without closing the surrounding dialog.
      event.preventDefault();
      event.stopPropagation();
      setDraft(String(value));
    }
  };
  return (
    <span className={`settings-number settings-number--${width}${disabled ? " is-disabled" : ""}`}>
      <TextInput
        uiSize="sm"
        type="number"
        inputMode="decimal"
        className="settings-number-input"
        value={draft}
        aria-label={unit ? `${label} (${unit})` : label}
        disabled={disabled}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        step={step}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      {unit && <span className="settings-number-unit" aria-hidden="true">{unit}</span>}
    </span>
  );
}

/** One numeric preference: exact −/+ nudges, a draggable track, a tabular
 *  readout, and an optional specimen rendered at the size it describes. The
 *  specimen is the point — a font-size row should show its own result, not
 *  only a number. Both the track and the buttons stay keyboard-reachable and
 *  announce the value through `aria-valuetext`. Every stepper shares one
 *  fixed-width grid so tracks and nudges align from row to row. */
export function SizeStepper({ value, min, max, step = 1, label, unit, onChange, specimen, ends }: {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Accessible name of the whole control; the track's `aria-label`. */
  label: string;
  /** Unit shown after the number and announced with it ("px", "%"). Empty
   *  for unitless scales, which then read "value / max". */
  unit: string;
  onChange: (value: number) => void;
  /** Live sample: the glyphs render at exactly the selected size. */
  specimen?: { text: string; mono?: boolean };
  /** Endpoint captions when the extremes are worth naming ("Square"/"Rounded");
   *  they render under the track so the control keeps the shared geometry. */
  ends?: [string, string];
}) {
  const settle = (next: number) => Math.min(max, Math.max(min, Math.round(next / step) * step));
  const nudge = (direction: -1 | 1) => onChange(settle(value + direction * step));
  const filled = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className={`size-stepper${ends ? " has-ends" : ""}`}>
      <IconButton
        className="size-stepper-nudge"
        icon={MinusIcon}
        label={tr("settings.parts.decrease", { label })}
        size="sm"
        disabled={value <= min}
        onClick={() => nudge(-1)}
      />
      <span className="size-stepper-rail">
        <input
          className="size-stepper-track"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          aria-valuetext={unit ? `${value} ${unit}` : `${value} / ${max}`}
          style={{ "--p": `${filled}%` } as CSSProperties}
          onChange={(event) => onChange(settle(Number(event.target.value)))}
        />
        {ends && (
          <span className="size-stepper-ends" aria-hidden="true">
            <span>{ends[0]}</span>
            <span>{ends[1]}</span>
          </span>
        )}
      </span>
      <IconButton
        className="size-stepper-nudge"
        icon={PlusIcon}
        label={tr("settings.parts.increase", { label })}
        size="sm"
        disabled={value >= max}
        onClick={() => nudge(1)}
      />
      {/* The specimen cell is always present (fixed width) so rows with and
          without a sample keep the same track geometry. */}
      <span
        className={`size-stepper-specimen${specimen?.mono ? " is-mono" : ""}`}
        style={specimen ? { fontSize: `${value}px` } : undefined}
        aria-hidden="true"
      >
        {specimen?.text}
      </span>
      {/* The track already exposes the value to assistive tech; the readout is
          the visual confirmation, so it stays out of the accessibility tree. */}
      <span className="size-stepper-value" aria-hidden="true">
        <b>{value}</b>
        {unit ? <i>{unit}</i> : <i>/{max}</i>}
      </span>
    </div>
  );
}

/** ≤4 mutually exclusive options. More options → `Select` from ui/. */
export function Seg<T extends string | number>({ value, options, onChange, label, disabled = false }: {
  value: T;
  /** Label is usually a string; filters may add a count (`<em className="seg-count">`). */
  options: Array<[T, ReactNode]>;
  onChange: (v: T) => void;
  /** Accessible group name, usually the Row label. */
  label?: string;
  disabled?: boolean;
}) {
  return (
    <div className="seg" role="group" {...(label ? { "aria-label": label } : {})}>
      {options.map(([id, optionLabel]) => (
        <Button
          key={id}
          variant="ghost"
          size="sm"
          className={value === id ? "on" : ""}
          aria-pressed={value === id}
          disabled={disabled}
          onClick={() => onChange(id)}
        >
          {optionLabel}
        </Button>
      ))}
    </div>
  );
}

export interface SettingsEmptyAction {
  label: string;
  onClick: () => void;
}

/** Empty / loading state for a settings list. `icon` is a semantic glyph key
 *  (`user`, `key`, `server`, `terminal`, `command`…; see packageIcons.tsx).
 *  `compact` is a left-aligned inline row for use inside a Section; the
 *  default panel is reserved for a page whose only content is the empty
 *  state. Put the primary "Add …" action here instead of floating it below. */
export function EmptyState({ title, body, busy = false, icon, action, compact = false }: {
  title: string;
  body?: string;
  busy?: boolean;
  icon?: string;
  action?: SettingsEmptyAction;
  compact?: boolean;
}) {
  const mark = busy
    ? <Spinner label={title} />
    // Never fall back to the core panel's generic clock: an unlabeled empty
    // state gets a neutral info glyph until the page passes its own icon.
    : <PackageGlyph icon={icon ?? "info"} size={compact ? 18 : 24} strokeWidth={1.7} />;
  if (compact) {
    return (
      <div className="settings-empty is-compact" role={busy ? "status" : undefined} aria-busy={busy || undefined}>
        {mark && <span className="settings-empty-mark" aria-hidden="true">{mark}</span>}
        <span className="settings-empty-copy">
          <strong>{title}</strong>
          {body && <span>{body}</span>}
        </span>
        {action && !busy && (
          <Button variant="quiet" size="sm" className="settings-empty-action" onClick={action.onClick}>{action.label}</Button>
        )}
      </div>
    );
  }
  return (
    <div className="settings-empty" role={busy ? "status" : undefined} aria-busy={busy || undefined}>
      <CoreEmptyState
        variant="panel"
        title={title}
        {...(body ? { description: body } : {})}
        {...(mark ? { mark } : {})}
        {...(action && !busy ? { actionLabel: action.label, onAction: action.onClick } : {})}
      />
    </div>
  );
}

export interface SettingsErrorText {
  /** One plain sentence for the reader. */
  message: string;
  /** Raw technical text for the details disclosure (never the headline). */
  details?: string;
  retryable: boolean;
}

function parseEmbeddedJson(text: string): { prefix: string; body: Record<string, unknown> } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const body = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return { prefix: text.slice(0, start).replace(/[\s:—–-]+$/u, "").trim(), body: body as Record<string, unknown> };
  } catch {
    return null;
  }
}

const isSentence = (value: unknown): value is string =>
  typeof value === "string" && value.trim().includes(" ") && !value.trim().startsWith("{");

/** Turn any thrown value — Error, Polyth error JSON, or a message with a
 *  serialized body appended — into a human sentence plus optional details.
 *  Serialized objects never become the headline. */
export function settingsErrorText(error: unknown): SettingsErrorText {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const embedded = raw ? parseEmbeddedJson(raw) : null;
  const objectBody = !raw && error && typeof error === "object" ? error as Record<string, unknown> : null;
  const body = embedded?.body ?? objectBody ?? {};
  const diagnostic = { ...readErrorDiagnostics(error), ...readErrorDiagnostics(body) };
  const details = raw || (objectBody ? JSON.stringify(objectBody) : undefined);
  const retryable = diagnostic.retryability !== "never";
  const human = isSentence(body.message) ? body.message.trim()
    : isSentence(body.error) ? body.error.trim()
      : !embedded && isSentence(raw) && raw.length <= 200 ? raw.trim()
        : "";
  let message: string;
  if (diagnostic.component === "client-transport" || diagnostic.component === "harness-transport") message = tr("settings.parts.errorConnection");
  else if (diagnostic.component === "auth" || diagnostic.code === "forbidden" || diagnostic.code === "unauthorized") message = tr("settings.parts.errorAuth");
  else if (human) message = human;
  else if (diagnostic.code === "not-found") message = tr("settings.parts.errorNotFound");
  else message = tr("settings.parts.errorGeneric");
  return { message, ...(details && details !== message ? { details } : {}), retryable };
}

/** Failed load/save for a settings page or section: title, one human
 *  sentence, "Try again", and the technical text behind a disclosure. */
export function ErrorState({ title, error, onRetry, compact = false }: {
  title?: string;
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const text = settingsErrorText(error);
  return (
    <div className={`settings-error${compact ? " is-compact" : ""}`} role="alert">
      <div className="settings-error-copy">
        <strong className="settings-error-title">{title ?? tr("settings.parts.errorTitle")}</strong>
        <p className="settings-error-message">{text.message}</p>
        {text.details && (
          <details className="settings-error-details">
            <summary>{tr("settings.parts.technicalDetails")}</summary>
            <pre>{text.details}</pre>
          </details>
        )}
      </div>
      {onRetry && text.retryable && (
        <Button variant="quiet" size="sm" className="settings-error-retry" onClick={onRetry}>
          {tr("settings.parts.tryAgain")}
        </Button>
      )}
    </div>
  );
}

export type SaveStatusState = "idle" | "saving" | "saved" | "error";

/** Subtle autosave confirmation next to a control or section action. Polite
 *  live region; renders nothing while idle. */
export function SaveStatus({ state, error }: { state: SaveStatusState; error?: string }) {
  return (
    <span className={`settings-save-status is-${state}`} role="status" aria-live="polite">
      {state === "saving" && tr("settings.parts.saving")}
      {state === "saved" && tr("settings.parts.saved")}
      {state === "error" && (error ?? tr("settings.parts.saveFailed"))}
    </span>
  );
}

/** Explicit save bar for draft-style settings (multi-field forms, prompts).
 *  Hidden-but-reserved until dirty so the layout never jumps; Save is the one
 *  primary button of its section. */
export function SaveBar({ dirty, canSave = true, saving = false, status = "idle", error, onSave, onDiscard, saveLabel }: {
  dirty: boolean;
  /** False while the draft is dirty but incomplete: Save stays off, Discard
   *  still reverts. */
  canSave?: boolean;
  saving?: boolean;
  status?: SaveStatusState;
  error?: string;
  onSave: () => void;
  onDiscard?: () => void;
  saveLabel?: string;
}) {
  return (
    <div className={`settings-save-bar${dirty ? " is-dirty" : ""}`}>
      <span className="settings-save-bar-note">
        {dirty ? tr("settings.parts.unsavedChanges") : <SaveStatus state={status} {...(error ? { error } : {})} />}
      </span>
      {onDiscard && (
        <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={onDiscard}>{tr("settings.parts.discard")}</Button>
      )}
      <Button variant="primary" size="sm" disabled={!dirty || !canSave} busy={saving} onClick={onSave}>
        {saveLabel ?? tr("settings.parts.save")}
      </Button>
    </div>
  );
}

/** The shell header owns the page title; PageHead only contributes the
 *  one-sentence orientation blurb, rendered as the subtitle directly under
 *  that title. Pages must not render their own H1/H2 page title. */
export function PageHead({ title, blurb }: { title?: string; blurb?: string }) {
  void title;
  if (!blurb) return null;
  return <p className="settings-page-blurb">{blurb}</p>;
}

/** Tab strip + panel for a settings detail view (harness detail, Monitoring).
 *  Wraps the accessible `ui/Tabs` with the settings spacing contract: one
 *  strip under the page/section head, panels start with `Section`s at a fixed
 *  gap, the strip scrolls horizontally on phones. Never use `Seg` or custom
 *  CSS as a tab strip. */
export function SettingsTabs({ tabs, value, onChange, label, idBase, children }: {
  tabs: readonly TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Accessible name of the strip ("OpenCode settings"). */
  label: string;
  idBase?: string;
  /** Content of the active tab. */
  children: ReactNode;
}) {
  const generated = useId();
  const base = idBase ?? generated;
  return (
    <div className="settings-tabs">
      <Tabs tabs={tabs} value={value} onChange={onChange} label={label} idBase={base} size="sm" className="settings-tabs-strip" />
      <TabPanel idBase={base} tabId={value} active className="settings-tab-panel">{children}</TabPanel>
    </div>
  );
}
