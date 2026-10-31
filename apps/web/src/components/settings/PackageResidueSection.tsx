// Data left behind by packages that are no longer installed. Removing a
// package folder (or a managed package) leaves its data directories in place
// on purpose; the instance owner deletes them here. Hidden for everyone else
// and when there is nothing to clean up.
import { useCallback, useEffect, useState } from "react";
import type { PackageResidueDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { ErrorState, ItemList, ItemRow, Section } from "./parts.tsx";
import { formatNumber, tr } from "../../i18n/index.ts";
import { Button, Icon, Spinner } from "../ui/index.ts";
import { DeleteIcon } from "../ui/icons.ts";

function formatSize(bytes: number): string {
  const [value, unit] = bytes >= 1024 ** 3 ? [bytes / 1024 ** 3, "gigabyte"]
    : bytes >= 1024 ** 2 ? [bytes / 1024 ** 2, "megabyte"]
      : [Math.max(bytes / 1024, bytes > 0 ? 0.1 : 0), "kilobyte"];
  return formatNumber(value, { style: "unit", unit, maximumFractionDigits: 1 });
}

export default function PackageResidueSection({ refreshKey }: { refreshKey?: unknown }) {
  const [residue, setResidue] = useState<PackageResidueDto[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setResidue((await api.packageResidue()).residue);
    } catch {
      // Not the instance owner, or an older server: show nothing.
      setResidue([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const purge = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api.packageResiduePurge(id);
      setConfirming(null);
      await load();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  };

  if (residue.length === 0) return null;
  return (
    <Section title={tr("settings.packagespage.residueTitle")} hint={tr("settings.packagespage.residueHint")}>
      <ItemList label={tr("settings.packagespage.residueTitle")}>
        {residue.map((entry) => {
          const spaces = entry.locations.filter((location) => location.spaceId !== null).length;
          return (
            <ItemRow
              key={entry.id}
              data-package-residue={entry.id}
              icon={<Icon icon={DeleteIcon} size="sm" />}
              title={entry.id}
              description={spaces > 0
                ? tr("settings.packagespage.residueSizeSpaces", { size: formatSize(entry.bytes), count: spaces })
                : tr("settings.packagespage.residueSize", { size: formatSize(entry.bytes) })}
              inactive
              trailing={(
                <>
                  {busy === entry.id && <Spinner size="sm" label={tr("settings.packagespage.applying")} />}
                  {confirming === entry.id ? (
                    <>
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirming(null)}>
                        {tr("settings.packagespage.residueCancel")}
                      </Button>
                      <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => { void purge(entry.id); }}>
                        {tr("settings.packagespage.residueConfirm")}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="quiet"
                      disabled={busy !== null}
                      aria-label={tr("settings.packagespage.residueDeleteNamed", { name: entry.id })}
                      onClick={() => setConfirming(entry.id)}
                    >
                      {tr("settings.packagespage.residueDelete")}
                    </Button>
                  )}
                </>
              )}
            />
          );
        })}
      </ItemList>
      {error !== null && <ErrorState compact error={error} />}
    </Section>
  );
}
