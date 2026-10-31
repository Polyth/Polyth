import { useCallback, useEffect, useRef, useState } from "react";
import type { HarnessRosterItem, HarnessSnapshot } from "@polyth/contracts";
import { isNetworkFailure, onConnectionRestored } from "@polyth/contracts/transport-retry";
import { peekHarnessRoster, peekHarnessSnapshots, readHarnessRoster, readHarnessSnapshots, useCatalogRevision } from "@polyth/models/runtime-catalog";
import { activeBrowserAccountId } from "@polyth/web/account-storage";

export const canExecute = (row: HarnessSnapshot): boolean => row.policy.enabled
  && row.availability.installed
  && row.availability.healthy
  && row.availability.authenticated !== false
  // A degraded probe can still be a valid manual target (notably a native
  // harness whose metadata command briefly failed). The execution boundary
  // rechecks it; hiding it here makes recovery impossible from the picker.
  && !["auth-required", "setup-required", "partially-configured", "incompatible", "offline", "not-installed"]
    .includes(row.availability.state);

/** `settings`: the Harnesses page revalidates instead of trusting stored rows,
 *  and its selected harness waits for a native readiness check. The picker
 *  keeps painting cached metadata. */
export function useHarnesses(projectId?: string | null, spaceId?: string, harnessId?: string, options: { settings?: boolean } = {}) {
  const settings = options.settings === true;
  const revision = useCatalogRevision();
  const scope = JSON.stringify([activeBrowserAccountId(), spaceId ?? "page", projectId ?? ""]);
  const key = JSON.stringify([scope, revision]);
  const [result, setResult] = useState<{ key: string; scope: string; rows: HarnessSnapshot[] }>();
  const [rosterResult, setRosterResult] = useState<{ key: string; scope: string; rows: HarnessRosterItem[] }>();
  const requestSeq = useRef(0);
  const [error, setError] = useState("");
  // A read that never reached Polyth (Link still reconnecting) is not a
  // harness problem: it is retried on reconnect and never toasted raw.
  const [unreachable, setUnreachable] = useState(false);
  // ModelPicker mounts its slot contributions only while the popover is open.
  // Reopening it must paint the page-local snapshot immediately instead of
  // flashing a fresh loading state around a cache hit.
  const hasCachedSnapshots = peekHarnessSnapshots({ projectId, spaceId }) !== undefined;
  const [loading, setLoading] = useState(!hasCachedSnapshots);
  const refresh = useCallback(async (force = false) => {
    const seq = ++requestSeq.current;
    if (force || peekHarnessSnapshots({ projectId, spaceId }) === undefined) setLoading(true);
    try {
      let rows = await readHarnessSnapshots({ projectId, spaceId, force, ...(settings && !force ? { fresh: true } : {}) });
      if (harnessId) {
        const selected = await readHarnessSnapshots({ projectId, spaceId, harnessId, ...(settings ? { verify: true } : { detail: true }) });
        rows = rows.map((row) => selected.find((item) => item.identity.id === row.identity.id) ?? row);
      }
      if (seq !== requestSeq.current) return;
      setResult({ key, scope, rows });
      setError("");
      setUnreachable(false);
    } catch (cause) {
      if (seq !== requestSeq.current) return;
      const lost = isNetworkFailure(cause);
      setUnreachable(lost);
      setError(lost ? "" : cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [key, scope, projectId, spaceId, harnessId, settings]);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void readHarnessRoster({ projectId, spaceId }).then((rows) => {
      if (active) setRosterResult({ key, scope, rows });
    }).catch(() => {});
    void refresh();
    return () => { active = false; requestSeq.current++; };
  }, [refresh, key, scope, projectId, spaceId, attempt]);
  // Ask again once the shell's connection is back instead of keeping an
  // empty picker until it is reopened. The failed read cached nothing.
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => unreachable ? onConnectionRestored(retry) : undefined, [unreachable, retry]);
  // An invalidation empties the caches while the replacement request is still
  // in flight. Same account/Space/project means the rows this instance already
  // painted stay true enough to keep the selected harness visible and marked;
  // a different scope falls back to nothing rather than showing foreign rows.
  const rows = result?.key === key
    ? result.rows
    : peekHarnessSnapshots({ projectId, spaceId }) ?? (result?.scope === scope ? result.rows : []);
  const roster = rosterResult?.key === key
    ? rosterResult.rows
    : peekHarnessRoster({ projectId, spaceId }) ?? (rosterResult?.scope === scope ? rosterResult.rows : []);
  return { rows, roster, error, unreachable, loading, refresh, retry };
}
