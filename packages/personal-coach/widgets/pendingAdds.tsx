import { useEffect, useRef, useState } from "react";
import type { CoachUi } from "./parts.tsx";
import { t } from "./strings.ts";

/** A title shown before the server created it; `failed` once it refused. */
export interface PendingAdd {
  key: string;
  text: string;
  failed: boolean;
}

let pendingSeq = 0;

/**
 * An add form that never waits on the server: the field clears and the title
 * shows as a pending row at once. Success drops the row once the caller's
 * refresh brought the real one; a rejection keeps the row, marked failed, with
 * its text one click from the field again. Each request is sent once.
 */
export function usePendingAdds(friendlyError: (action: string, cause: unknown) => string) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingAdd[]>([]);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const submit = (failLabel: string, create: (title: string) => Promise<unknown>, after?: () => unknown) => {
    const title = text.trim();
    if (!title) return;
    const key = `pending-${++pendingSeq}`;
    setText("");
    setError("");
    setPending((current) => [...current, { key, text: title, failed: false }]);
    void create(title)
      .then(async () => {
        await after?.();
        if (mounted.current) setPending((current) => current.filter((item) => item.key !== key));
      })
      .catch((cause) => {
        if (!mounted.current) return;
        setPending((current) => current.map((item) => item.key === key ? { ...item, failed: true } : item));
        setError(friendlyError(failLabel, cause));
      });
  };
  const edit = (item: PendingAdd) => {
    setPending((current) => current.filter((entry) => entry.key !== item.key));
    setText((current) => current.trim() ? `${current.trim()} ${item.text}` : item.text);
    setError("");
  };
  const dismiss = (item: PendingAdd) => {
    setPending((current) => current.filter((entry) => entry.key !== item.key));
  };
  return { text, setText, pending, error, submit, edit, dismiss };
}

export function PendingRows({ items, ui, onEdit, onDismiss }: {
  items: readonly PendingAdd[];
  ui: CoachUi;
  onEdit(item: PendingAdd): void;
  onDismiss(item: PendingAdd): void;
}) {
  const { Button } = ui;
  if (items.length === 0) return null;
  return <div className="coach-list coach-pending-list">
    {items.map((item) => (
      <div
        key={item.key}
        className={`coach-row coach-row--quiet coach-row--${item.failed ? "failed" : "pending"}`}
        aria-busy={!item.failed}
      >
        <span className="coach-row-copy">
          <span className="coach-row-title">{item.text}</span>
          <span className="coach-meta" role={item.failed ? undefined : "status"}>
            {item.failed ? t("coach.pending.failed") : t("coach.pending.adding")}
          </span>
        </span>
        {item.failed && <span className="coach-row-actions">
          <Button size="sm" variant="ghost" onClick={() => onEdit(item)}>{t("coach.pending.edit")}</Button>
          <Button size="sm" variant="ghost" onClick={() => onDismiss(item)}>{t("coach.pending.dismiss")}</Button>
        </span>}
      </div>
    ))}
  </div>;
}
