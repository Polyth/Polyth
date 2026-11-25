// Shows or hides one account harness in the picker from the Accounts list:
// the same Space preference (`enabled`) the harness list's switch writes. A
// hidden account still runs for a Relay the person added it to.
import { useCallback, useEffect, useState } from "react";
import type { HarnessRosterItem } from "@polyth/contracts";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { invalidateRuntimeCatalogs, readHarnessSnapshots } from "@polyth/models/runtime-catalog";
import { pickerPreferences } from "./accountsModel.ts";

const api = createApiTransport();

export interface PickerVisibility {
  /** The caller may change it (harness manager) and the roster is known. */
  editable: boolean;
  /** `undefined` while unknown, or for a harness the roster does not list. */
  shown(harnessId: string): boolean | undefined;
  set(harnessId: string, shown: boolean): void;
  /** The harness id being saved, if any. */
  saving: string;
  failure: string;
}

/** `enabled`: read nothing until the list needs it. `revision`: read the
 *  roster again after something changed what it lists (a Relay save, an
 *  added account), so a save never sends a stale row set. */
export function usePickerVisibility({ host, projectId, enabled, revision, label }: {
  host: WebPackageHost;
  projectId?: string | null;
  enabled: boolean;
  revision: number;
  /** The failed action, for the error message. */
  label: string;
}): PickerVisibility {
  const [manage, setManage] = useState(false);
  const [roster, setRoster] = useState<HarnessRosterItem[]>();
  const [saving, setSaving] = useState("");
  const [failure, setFailure] = useState("");
  // Fresh, not the picker's day-long cache: a save sends every row back.
  const load = useCallback(async () => {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    try {
      setRoster(await api.get<HarnessRosterItem[]>(`/api/harnesses/roster${query}`));
    } catch {
      setRoster(undefined);
    }
  }, [projectId]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void api.get<{ manage: boolean }>("/api/harnesses/access").then((access) => { if (live) setManage(access.manage === true); }, () => {});
    return () => { live = false; };
  }, [enabled]);
  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load, revision]);

  const set = (harnessId: string, shown: boolean) => {
    if (!roster || saving) return;
    const before = roster;
    setRoster(roster.map((row) => row.identity.id === harnessId ? { ...row, policy: { ...row.policy, enabled: shown } } : row));
    setSaving(harnessId);
    setFailure("");
    void (async () => {
      try {
        await api.put("/api/harnesses/preferences", pickerPreferences(before, harnessId, shown));
        // Harness rows and picker tabs come from the catalog.
        await readHarnessSnapshots({ projectId, force: true }).catch(() => {});
        invalidateRuntimeCatalogs();
        await load();
      } catch (cause) {
        setRoster(before);
        setFailure(host.errors.friendly(label, cause));
      } finally {
        setSaving("");
      }
    })();
  };

  return {
    editable: manage && roster !== undefined,
    shown: (harnessId) => roster?.find((row) => row.identity.id === harnessId)?.policy.enabled,
    set,
    saving,
    failure,
  };
}
