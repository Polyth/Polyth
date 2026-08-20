// Shared building blocks for settings pages.
import type { ReactNode } from "react";

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
  return (
    <button className="switch set-toggle" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}

export function Seg<T extends string>({ value, options, onChange }: {
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

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="set-empty">
      <div className="set-empty-title">{title}</div>
      {body && <div className="set-empty-body">{body}</div>}
    </div>
  );
}

export function PageHead({ title, blurb }: { title: string; blurb?: string }) {
  return (
    <div className="set-page-head">
      <h3>{title}</h3>
      {blurb && <p className="muted">{blurb}</p>}
    </div>
  );
}
