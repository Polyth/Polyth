// Shared building blocks for settings pages.
import type { ReactNode } from "react";
import Switch from "../ui/Switch.tsx";

export function Row({ label, hint, itemId, children }: { label: string; hint?: string; itemId?: string; children: ReactNode }) {
  return (
    <div className="set-row settings-row" {...(itemId ? { "data-settings-item": itemId } : {})}>
      <div className="set-row-text">
        <div className="set-row-label">{label}</div>
        {hint && <div className="set-row-hint">{hint}</div>}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <Switch checked={on} onChange={onChange} className="set-toggle" {...(label !== undefined ? { label } : {})} />;
}

export function Seg<T extends string | number>({ value, options, onChange }: {
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map(([id, label]) => (
        <button key={id} className={value === id ? "on" : ""} onClick={() => onChange(id)}>{label}</button>
      ))}
    </div>
  );
}

export function EmptyState({ title, body, busy = false }: { title: string; body?: string; busy?: boolean }) {
  return (
    <div className="set-empty" role={busy ? "status" : undefined} aria-busy={busy || undefined}>
      <span className="set-empty-mark" aria-hidden="true">
        {busy ? <span className="spinner" /> : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M8.5 12h7M12 8.5v7" />
          </svg>
        )}
      </span>
      <div className="set-empty-title">{title}</div>
      {body && <div className="set-empty-body">{body}</div>}
    </div>
  );
}

export function PageHead({ title, blurb }: { title: string; blurb?: string }) {
  // The settings shell already owns the page title. Keeping a second heading
  // (and a generic description) here made every page read like two titles.
  // Keep this component as a compatibility seam for contributed pages.
  void title;
  void blurb;
  return null;
}
