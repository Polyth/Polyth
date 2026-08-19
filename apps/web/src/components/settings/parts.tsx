// Shared building blocks for settings pages.
import type { ReactNode } from "react";

export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="set-row">
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
    <label className="set-toggle">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span className="set-toggle-track"><span className="set-toggle-knob" /></span>
    </label>
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
