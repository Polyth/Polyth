import { readErrorDiagnostics } from "@polyth/contracts";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { customTitlesStrings } from "./strings.ts";

const api = createApiTransport();

/** Requests in flight at once: each one is a title-model call. */
const CONCURRENCY = 3;

export type BulkReport = (operation: string, succeeded: number, failed: Array<{ id: string; code: string }>) => void;

/** Regenerate every title through the same route as the row action; one
 *  session's refusal (no message yet, a concurrent rename) never stops the rest. */
export async function regenerateTitles(sessionIds: readonly string[]): Promise<{
  succeeded: number;
  failed: Array<{ id: string; code: string }>;
}> {
  let succeeded = 0;
  const failed: Array<{ id: string; code: string }> = [];
  let next = 0;
  const worker = async () => {
    while (next < sessionIds.length) {
      const id = sessionIds[next++]!;
      try {
        await api.post(`/api/custom-titles/sessions/${encodeURIComponent(id)}/regenerate`);
        succeeded += 1;
      } catch (cause) {
        failed.push({ id, code: readErrorDiagnostics(cause).code ?? "error" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sessionIds.length) }, worker));
  return { succeeded, failed };
}

export default function RegenerateTitlesBulkAction({ host, sessionIds, closeMenu, done, report }: {
  host: WebPackageHost;
  sessionIds: readonly string[];
  closeMenu?: () => void;
  done?: () => void;
  report?: BulkReport;
}) {
  const copy = customTitlesStrings(host.ui.locale.get());
  const label = copy.regenerateMany;
  const run = () => {
    closeMenu?.();
    // The selection ends at once; titles arrive on the rows as each one lands.
    done?.();
    void regenerateTitles(sessionIds).then(({ succeeded, failed }) => {
      report?.(copy.retitled, succeeded, failed);
    });
  };
  const RegenerateIcon = host.ui.icons.regenerate;
  return (
    <button type="button" role="menuitem" className="ui-menu-item" onClick={run}>
      {RegenerateIcon && <RegenerateIcon />}
      <span className="ui-menu-item-copy"><span className="ui-menu-item-label">{label}</span></span>
    </button>
  );
}
