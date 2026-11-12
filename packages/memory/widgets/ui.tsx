// The host's shared controls, as this package uses them. The shell hands its
// primitives over through `MemoryUiContext`; without it (tests, a host that
// predates the handle) each control falls back to the plain semantic element,
// so behaviour stays the same and only the paint differs.
import { createContext, useContext, type ChangeEvent, type ComponentType, type KeyboardEvent, type ReactNode, type Ref } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";

type HostUi = WebPackageHost["ui"];
export type MemoryUi = Pick<HostUi, "components" | "icons">;
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
  "aria-describedby"?: string | undefined;
  "aria-pressed"?: boolean;
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

type FieldProps = {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
};

export function TextField({ onChange, type, inputMode, onBlur, onKeyDown, ...rest }: FieldProps & {
  type?: "text" | "search" | "number";
  inputMode?: "numeric";
  onBlur?(): void;
  onKeyDown?(event: KeyboardEvent<HTMLInputElement>): void;
}) {
  const ui = useContext(MemoryUiContext);
  const props = {
    ...rest, type: type ?? "text", ...(inputMode ? { inputMode } : {}), ...(onBlur ? { onBlur } : {}), ...(onKeyDown ? { onKeyDown } : {}),
    onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
  };
  if (ui) {
    const TextInput = ui.components.TextInput as unknown as Loose;
    return <TextInput {...props} />;
  }
  return <input {...props} />;
}

export function TextArea({ onChange, rows, maxLength, ...rest }: FieldProps & { rows?: number; maxLength?: number }) {
  const ui = useContext(MemoryUiContext);
  const props = {
    ...rest, ...(rows ? { rows } : {}), ...(maxLength ? { maxLength } : {}),
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
  };
  if (ui) {
    const Textarea = ui.components.Textarea as unknown as Loose;
    return <Textarea {...props} />;
  }
  return <textarea {...props} />;
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
