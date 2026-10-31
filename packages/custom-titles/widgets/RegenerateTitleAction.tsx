import { useEffect, useRef, useState } from "react";
import { readErrorDiagnostics } from "@polyth/contracts";
import { createApiTransport, friendlyError, type WebPackageHost } from "@polyth/web-sdk";
import { customTitlesStrings } from "./strings.ts";

const api = createApiTransport();

export default function RegenerateTitleAction({ host, sessionId, closeMenu }: {
  host: WebPackageHost;
  sessionId: string;
  closeMenu?: () => void;
}) {
  const mounted = useRef(false);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const copy = customTitlesStrings(host.ui.locale.get());
  const label = copy.regenerate;
  const working = copy.regenerating;
  const regenerate = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await api.post<{ fallback?: boolean }>(`/api/custom-titles/sessions/${encodeURIComponent(sessionId)}/regenerate`);
      if (!mounted.current) return;
      // The title changed either way. When the model gave nothing usable the
      // name came from the message itself; say so instead of passing it off as
      // the model's, and keep the menu open long enough to read.
      if (result?.fallback) setNote(copy.fallbackNote);
      else closeMenu?.();
    } catch (cause) {
      if (mounted.current) {
        const action = copy.failed;
        const diagnostic = readErrorDiagnostics(cause);
        // This operation renames a title; the generic unknown-outcome notice
        // describes sending a message and preserving a composer draft.
        setError(diagnostic.operation === "title-regenerate" && diagnostic.mutationOutcome === "unknown"
          ? friendlyError(action, cause)
          : host.errors.friendly(action, cause));
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const RegenerateIcon = host.ui.icons.regenerate;
  return (
    <div className="custom-titles-action">
      <button
        type="button"
        role="menuitem"
        className="ui-menu-item"
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => void regenerate()}
      >
        {busy
          ? <span className="ui-spinner ui-spinner--sm" aria-hidden="true" />
          : RegenerateIcon && <RegenerateIcon />}
        <span className="ui-menu-item-copy"><span className="ui-menu-item-label">{busy ? working : label}</span></span>
      </button>
      {error && <p className="custom-titles-action__error" role="alert">{error}</p>}
      {note && <p className="custom-titles-action__note" role="status">{note}</p>}
    </div>
  );
}
