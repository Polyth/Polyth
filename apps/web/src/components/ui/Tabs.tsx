// Accessible tab strip: roving tabindex, arrow/Home/End navigation with
// automatic activation. Panels are caller-owned; TabPanel wires the ids.
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabItem {
  id: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Accessible name of the tab strip. */
  label: string;
  /** Shared id base linking tabs to TabPanels; auto-generated otherwise. */
  idBase?: string;
  size?: "sm" | "md";
  className?: string;
}

export function tabId(idBase: string, id: string): string {
  return `${idBase}-tab-${id}`;
}

export function tabPanelId(idBase: string, id: string): string {
  return `${idBase}-panel-${id}`;
}

export default function Tabs({ tabs, value, onChange, label, idBase, size = "md", className }: TabsProps) {
  const generated = useId();
  const base = idBase ?? generated;
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const enabled = tabs.filter((tab) => !tab.disabled);
    if (enabled.length === 0) return;
    const current = Math.max(0, enabled.findIndex((tab) => tab.id === value));
    const next =
      event.key === "Home" ? 0
      : event.key === "End" ? enabled.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length;
    const target = enabled[next]!;
    onChange(target.id);
    listRef.current
      ?.querySelector<HTMLElement>(`[id="${tabId(base, target.id)}"]`)
      ?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      className={`ui-tabs ui-tabs--${size}${className ? ` ${className}` : ""}`}
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabId(base, tab.id)}
            aria-selected={selected}
            aria-controls={tabPanelId(base, tab.id)}
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            className={`ui-tab${selected ? " ui-tab--selected" : ""}`}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  idBase: string;
  tabId: string;
  active: boolean;
  children: ReactNode;
  className?: string;
}

export function TabPanel({ idBase, tabId: id, active, children, className }: TabPanelProps) {
  if (!active) return null;
  return (
    <div
      role="tabpanel"
      id={tabPanelId(idBase, id)}
      aria-labelledby={tabId(idBase, id)}
      tabIndex={0}
      className={`ui-tab-panel${className ? ` ${className}` : ""}`}
    >
      {children}
    </div>
  );
}
