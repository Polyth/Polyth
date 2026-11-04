// Accessible tab strip: roving tabindex, arrow/Home/End navigation with
// automatic activation. Panels are caller-owned; TabPanel wires the ids.
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

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
    const current = enabled.findIndex((tab) => tab.id === value);
    const next =
      event.key === "Home" ? 0
      : event.key === "End" ? enabled.length - 1
      // An arrow key with the selection outside this strip enters at the first
      // tab rather than skipping it.
      : current < 0 ? 0
      : (current + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length;
    const target = enabled[next]!;
    onChange(target.id);
    listRef.current
      ?.querySelector<HTMLElement>(`[id="${tabId(base, target.id)}"]`)
      ?.focus();
  };

  // Roving tabindex needs exactly one entry point. When the current value is
  // not one of these tabs — a strip that lists part of a larger set, or a
  // surface whose selection is momentarily elsewhere — the first enabled tab
  // holds it so the tablist never drops out of the keyboard order.
  const selectedIndex = tabs.findIndex((tab) => tab.id === value && !tab.disabled);
  const entryIndex = selectedIndex >= 0 ? selectedIndex : tabs.findIndex((tab) => !tab.disabled);

  // A strip wider than its box scrolls sideways. On a phone nothing showed
  // that: the last tab was simply cut at the edge. Mark which edges hide tabs
  // so CSS fades them, and keep the selected tab inside the visible part.
  const tabCount = tabs.length;
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const update = () => {
      const max = list.scrollWidth - list.clientWidth;
      const offset = Math.abs(list.scrollLeft);
      const start = max > 1 && offset > 1 ? "true" : "false";
      const end = max > 1 && offset < max - 1 ? "true" : "false";
      if (list.dataset.overflowStart !== start) list.dataset.overflowStart = start;
      if (list.dataset.overflowEnd !== end) list.dataset.overflowEnd = end;
    };
    update();
    list.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(list);
    return () => {
      list.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [tabCount]);
  useEffect(() => {
    const list = listRef.current;
    if (!list || list.scrollWidth <= list.clientWidth + 1) return;
    const tab = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!tab) return;
    const box = list.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    // Room for the edge fade, so the selected tab never sits under it.
    const fade = 24;
    if (rect.left < box.left + fade) list.scrollLeft -= box.left + fade - rect.left;
    else if (rect.right > box.right - fade) list.scrollLeft += rect.right - (box.right - fade);
  }, [value, tabCount]);

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      className={`ui-tabs ui-tabs--${size}${className ? ` ${className}` : ""}`}
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabId(base, tab.id)}
            aria-selected={selected}
            aria-controls={tabPanelId(base, tab.id)}
            tabIndex={index === entryIndex ? 0 : -1}
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
