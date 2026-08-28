// Shared building blocks for settings pages.
import type { ReactNode } from "react";
import Button from "../ui/Button.tsx";
import CoreEmptyState from "../EmptyState.tsx";
import Spinner from "../ui/Spinner.tsx";
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
        <Button
          key={id}
          variant="ghost"
          size="sm"
          className={value === id ? "on" : ""}
          aria-pressed={value === id}
          onClick={() => onChange(id)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

export function EmptyState({ title, body, busy = false }: { title: string; body?: string; busy?: boolean }) {
  return (
    <div className="settings-empty" role={busy ? "status" : undefined} aria-busy={busy || undefined}>
      <CoreEmptyState
        variant="panel"
        title={title}
        {...(body ? { description: body } : {})}
        {...(busy ? { mark: <Spinner label={title} /> } : {})}
      />
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
