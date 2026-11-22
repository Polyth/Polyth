// The host's shared controls, as this package uses them. The shell hands its
// primitives over through `MemoryUiContext`; without it (tests, a host that
// predates the handle) each control falls back to the plain semantic element,
// so behaviour stays the same and only the paint differs.
import { createContext, useCallback, useContext, useRef, type ChangeEvent, type ComponentType, type KeyboardEvent, type ReactNode, type Ref } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";

type HostUi = WebPackageHost["ui"];
export type MemoryUi = Pick<HostUi, "components" | "icons"> & Partial<Pick<HostUi, "confirm">>;
export const MemoryUiContext = createContext<MemoryUi | null>(null);

type Loose = ComponentType<Record<string, unknown>>;
type IconName = "back" | "plus" | "more" | "search" | "close";

const classes = (...parts: Array<string | false | undefined>): string => parts.filter(Boolean).join(" ");

export function Btn({ variant = "quiet", size = "sm", icon, className, children, ...rest }: {
  variant?: "primary" | "quiet" | "ghost" | "danger";
  size?: "sm" | "md";
  icon?: IconName;
  className?: string;
  disabled?: boolean;
  busy?: boolean;
  onClick?: () => void;
  children?: ReactNode;
  title?: string;
  "aria-describedby"?: string | undefined;
  "aria-pressed"?: boolean;
  "aria-keyshortcuts"?: string;
}) {
  const ui = useContext(MemoryUiContext);
  // The variant class is a stable hook (focus moves, tests); the host paints.
  const hook = classes("memory-button", variant !== "quiet" && variant !== "ghost" && `memory-button-${variant}`, className);
  if (ui) {
    const Button = ui.components.Button as unknown as Loose;
    return <Button variant={variant} size={size} className={hook} {...(icon ? { iconStart: ui.icons[icon] } : {})} {...rest}>{children}</Button>;
  }
  const { busy, ...native } = rest;
  return <button type="button" className={hook} {...native} disabled={native.disabled || busy}>{children}</button>;
}

/** One glyph-only action; `label` is its name and tooltip. */
export function IconBtn({ icon, label, onClick, disabled, className }: { icon: IconName; label: string; onClick(): void; disabled?: boolean; className?: string }) {
  const ui = useContext(MemoryUiContext);
  if (ui) {
    const IconButton = ui.components.IconButton as unknown as Loose;
    return <IconButton icon={ui.icons[icon]} label={label} size="sm" variant="ghost" onClick={onClick} disabled={disabled} className={className} />;
  }
  return <button type="button" className={className} aria-label={label} title={label} disabled={disabled} onClick={onClick}>×</button>;
}

/** The host confirmation alert, or the browser's without a host. */
export function useConfirm(): (message: string, options?: { title?: string; confirmLabel?: string; destructive?: boolean }) => Promise<boolean> {
  const ui = useContext(MemoryUiContext);
  return useCallback(async (message, options) => {
    if (ui?.confirm) return ui.confirm(message, options);
    return typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(message) : false;
  }, [ui]);
}

export interface MenuItem {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect(): void;
}

/** A ⋯ button that opens the host menu: one calm control instead of a row of
 *  buttons. The fallback lists the same actions as plain buttons. */
export function ActionMenu({ label, entries, disabled }: { label: string; entries: ReadonlyArray<MenuItem | "separator">; disabled?: boolean }) {
  const ui = useContext(MemoryUiContext);
  if (ui) {
    const Menu = ui.components.Menu as unknown as Loose;
    const IconButton = ui.components.IconButton as unknown as Loose;
    return (
      <Menu label={label} entries={entries} align="end">
        {(trigger: Record<string, unknown>) => <IconButton icon={ui.icons.more} label={label} size="sm" variant="ghost" disabled={disabled} {...trigger} />}
      </Menu>
    );
  }
  return (
    <span className="memory-menu-fallback" role="group" aria-label={label}>
      {entries.map((entry) => entry === "separator" ? null : (
        <button key={entry.id} type="button" disabled={disabled || entry.disabled} onClick={entry.onSelect}>{entry.label}</button>
      ))}
    </span>
  );
}

export function Choice({ label, value, options, onChange, disabled, align }: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange(value: string): void;
  disabled?: boolean;
  align?: "start" | "end";
}) {
  const ui = useContext(MemoryUiContext);
  if (ui) {
    const Select = ui.components.Select as unknown as Loose;
    return <Select label={label} value={value} options={options} onChange={onChange} disabled={disabled} searchable={false} {...(align ? { align } : {})} />;
  }
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

/** One choice from a short known set, every option in view: one tap instead
 *  of opening a list. A radio group with roving focus (arrows, Home, End). */
export function Chips({ label, value, options, onChange, disabled, className }: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange(value: string): void;
  disabled?: boolean;
  className?: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const current = options.some((option) => option.value === value) ? value : options[0]?.value;
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const rtl = group.current ? getComputedStyle(group.current).direction === "rtl" : false;
    const step = { ArrowRight: rtl ? -1 : 1, ArrowDown: 1, ArrowLeft: rtl ? 1 : -1, ArrowUp: -1 }[event.key];
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
      : step === undefined ? -1 : (index + step + options.length) % options.length;
    if (next < 0) return;
    event.preventDefault();
    const option = options[next]!;
    onChange(option.value);
    group.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  };
  return (
    <div ref={group} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className={classes("memory-chips", className)}>
      {options.map((option, index) => {
        const checked = option.value === current;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            className="memory-chip"
            onClick={() => { if (!checked) onChange(option.value); }}
            onKeyDown={(event) => move(event, index)}
          >{option.label}</button>
        );
      })}
    </div>
  );
}

export function Check({ checked, onChange, label, disabled, className }: {
  checked: boolean;
  onChange(checked: boolean): void;
  label: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const ui = useContext(MemoryUiContext);
  const hook = classes("memory-check", className);
  if (ui) {
    const Checkbox = ui.components.Checkbox as unknown as Loose;
    return <Checkbox checked={checked} onChange={onChange} label={label} disabled={disabled} className={hook} />;
  }
  return <label className={hook}><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /> {label}</label>;
}

/** An on/off preference that applies at once: the host Switch where it has
 *  one, else a checkbox with the same name. */
export function Toggle({ checked, onChange, label, labelledBy, disabled }: {
  checked: boolean;
  onChange(checked: boolean): void;
  label: string;
  labelledBy?: string;
  disabled?: boolean;
}) {
  const ui = useContext(MemoryUiContext);
  const Switch = ui?.components.Switch as unknown as Loose | undefined;
  if (Switch) return <Switch checked={checked} onChange={onChange} {...(labelledBy ? { labelledBy } : { label })} disabled={disabled} />;
  return <Check checked={checked} onChange={onChange} disabled={disabled} label={labelledBy ? <span className="memory-sr">{label}</span> : label} />;
}

type FieldProps = {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
};

export function TextField({ onChange, type, inputMode, onBlur, onKeyDown, inputRef, enterKeyHint, autoComplete, ...rest }: FieldProps & {
  type?: "text" | "search" | "number";
  inputMode?: "numeric" | "search";
  enterKeyHint?: "search" | "done" | "next" | "enter";
  autoComplete?: string;
  inputRef?: Ref<HTMLInputElement>;
  onBlur?(): void;
  onKeyDown?(event: KeyboardEvent<HTMLInputElement>): void;
}) {
  const ui = useContext(MemoryUiContext);
  const props = {
    ...rest, type: type ?? "text",
    ...(inputMode ? { inputMode } : {}), ...(enterKeyHint ? { enterKeyHint } : {}), ...(autoComplete ? { autoComplete } : {}),
    ...(onBlur ? { onBlur } : {}), ...(onKeyDown ? { onKeyDown } : {}), ...(inputRef ? { ref: inputRef } : {}),
    onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
  };
  if (ui) {
    const TextInput = ui.components.TextInput as unknown as Loose;
    return <TextInput {...props} />;
  }
  return <input {...props} />;
}

export function TextArea({ onChange, rows, maxLength, autoGrow, minRows, maxRows, onKeyDown, textareaRef, ...rest }: FieldProps & {
  rows?: number;
  maxLength?: number;
  /** Grow with the text between `minRows` and `maxRows`, then scroll. */
  autoGrow?: boolean;
  minRows?: number;
  maxRows?: number;
  textareaRef?: Ref<HTMLTextAreaElement>;
  onKeyDown?(event: KeyboardEvent<HTMLTextAreaElement>): void;
}) {
  const ui = useContext(MemoryUiContext);
  const props = {
    ...rest, ...(maxLength ? { maxLength } : {}), ...(onKeyDown ? { onKeyDown } : {}), ...(textareaRef ? { ref: textareaRef } : {}),
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
  };
  if (ui) {
    const Textarea = ui.components.Textarea as unknown as Loose;
    return <Textarea {...props} {...(autoGrow ? { autoGrow, minRows: minRows ?? rows ?? 2, maxRows: maxRows ?? 12 } : rows ? { rows, minRows: rows } : {})} />;
  }
  return <textarea {...props} rows={minRows ?? rows ?? 2} />;
}

export interface TabEntry { id: string; label: ReactNode }

export function TabStrip({ tabs, value, onChange, label, idBase }: { tabs: readonly TabEntry[]; value: string; onChange(id: string): void; label: string; idBase: string }) {
  const ui = useContext(MemoryUiContext);
  if (ui) {
    const Tabs = ui.components.Tabs as unknown as Loose;
    return <Tabs tabs={tabs} value={value} onChange={onChange} label={label} idBase={idBase} className="memory-tabs" />;
  }
  return (
    <div role="tablist" aria-label={label} className="memory-tabs">
      {tabs.map((tab) => (
        <button key={tab.id} type="button" role="tab" id={tabDomId(idBase, tab.id)} aria-controls={panelDomId(idBase, tab.id)} aria-selected={tab.id === value} onClick={() => onChange(tab.id)}>{tab.label}</button>
      ))}
    </div>
  );
}

// The host `Tabs` derives the same ids from `idBase`.
export const tabDomId = (idBase: string, id: string): string => `${idBase}-tab-${id}`;
export const panelDomId = (idBase: string, id: string): string => `${idBase}-panel-${id}`;

/** A panel that stays mounted while hidden, so a draft in one tab survives a
 *  look at another. */
export function TabPane({ idBase, id, active, children, paneRef }: { idBase: string; id: string; active: boolean; children: ReactNode; paneRef?: Ref<HTMLDivElement> }) {
  return <div ref={paneRef} role="tabpanel" id={panelDomId(idBase, id)} aria-labelledby={tabDomId(idBase, id)} hidden={!active} className="memory-pane">{children}</div>;
}

/** A decorative host glyph (search, pin…), or nothing without a host. */
export function Glyph({ name }: { name: IconName }) {
  const ui = useContext(MemoryUiContext);
  const Icon = ui?.icons[name];
  return Icon ? <span className="memory-glyph" aria-hidden="true"><Icon /></span> : null;
}

/** A decorative busy mark (the surrounding region owns the status). */
export function BusyMark() {
  const ui = useContext(MemoryUiContext);
  const Spinner = ui?.components.Spinner as unknown as Loose | undefined;
  return Spinner ? <span className="memory-busy" aria-hidden="true"><Spinner size="sm" /></span> : <span className="memory-busy memory-busy--plain" aria-hidden="true" />;
}
