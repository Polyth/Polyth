import { useCallback, useEffect, useState } from "react";
import type { HarnessSnapshot, PersonHarnessDefaultDto } from "@polyth/contracts";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { invalidateRuntimeCatalogs } from "@polyth/models/runtime-catalog";
import { Notice, Select } from "../../../apps/web/src/components/ui/index.ts";
import { Row, Section } from "../../../apps/web/src/components/settings/parts.tsx";

const api = createApiTransport();
/** The Select value for "no personal default". */
const PROJECT_DEFAULT = "";

/** The signed-in person's own default harness (Spaces §13). `undefined` until
 *  loaded; `null` when the server has no such route (older server, package
 *  off) or the caller is not a person, so the picker stays hidden. */
export function usePersonDefaultHarness(host: WebPackageHost) {
  const [value, setValue] = useState<PersonHarnessDefaultDto | null>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    let live = true;
    void api.get<PersonHarnessDefaultDto>("/api/harnesses/default").then(
      (dto) => { if (live) setValue(dto); },
      () => { if (live) setValue(null); },
    );
    return () => { live = false; };
  }, []);
  const save = useCallback(async (harnessId: string | null) => {
    setBusy(true);
    setFailure("");
    try {
      setValue(await api.put<PersonHarnessDefaultDto>("/api/harnesses/default", { harnessId }));
      // New-chat composers read the default with the harness catalogs.
      invalidateRuntimeCatalogs();
    } catch (cause) {
      setFailure(host.errors.friendly(host.ui.locale.translate("harnessruntime.personDefault.saveAction"), cause));
    } finally {
      setBusy(false);
    }
  }, [host]);
  return { value, busy, failure, save };
}

/** Harnesses a person may choose as their default: the ones listed for them
 *  (the server already hides what they can't use, including other people's
 *  private accounts) that are turned on here. */
export const personDefaultChoices = (rows: readonly HarnessSnapshot[]): HarnessSnapshot[] =>
  rows.filter((row) => row.policy.enabled);

export function PersonDefaultHarnessSection({ host, rows, state }: {
  host: WebPackageHost;
  rows: readonly HarnessSnapshot[];
  state: ReturnType<typeof usePersonDefaultHarness>;
}) {
  const t = (key: string, values?: Record<string, string | number>) => host.ui.locale.translate(`harnessruntime.personDefault.${key}`, values);
  const { value, busy, failure, save } = state;
  if (!value) return null;
  const choices = personDefaultChoices(rows);
  const saved = value.harnessId;
  const missing = saved !== null && !choices.some((row) => row.identity.id === saved);
  const savedName = rows.find((row) => row.identity.id === saved)?.identity.name ?? saved;
  return <Section title={t("title")} hint={t("hint")}>
    <Row label={t("label")} itemId="harnesses.person-default" hint={t("rowHint")}>
      <Select
        label={t("label")}
        value={saved ?? PROJECT_DEFAULT}
        disabled={busy}
        options={[
          { value: PROJECT_DEFAULT, label: t("projectDefault"), detail: t("projectDefaultDetail") },
          ...choices.map((row) => ({ value: row.identity.id, label: row.identity.name })),
          ...(missing && saved ? [{ value: saved, label: savedName ?? saved, detail: t("unavailableHere") }] : []),
        ]}
        onChange={(next) => { if (next !== (saved ?? PROJECT_DEFAULT)) void save(next || null); }}
      />
    </Row>
    {saved !== null && !value.usable && <Notice tone="warning">{t("unusable", { name: savedName ?? "" })}</Notice>}
    {failure && <Notice tone="error" role="alert">{failure}</Notice>}
  </Section>;
}
