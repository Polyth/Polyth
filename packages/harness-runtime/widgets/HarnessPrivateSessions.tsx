import { useEffect, useState } from "react";
import type { HarnessSnapshot } from "@polyth/contracts";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { Notice, Switch } from "../../../apps/web/src/components/ui/index.ts";
import { Row } from "../../../apps/web/src/components/settings/parts.tsx";

const api = createApiTransport();

/** Whether new conversations on this harness are private sessions: Polyth
 *  keeps them, the harness saves nothing to its own history. Rendered only for
 *  a harness that supports it (`policy.privateSessions` is present). */
export default function HarnessPrivateSessions({ host, detail, canManage }: { host: WebPackageHost; detail: HarnessSnapshot; canManage: boolean }) {
  const t = (key: string, values?: Record<string, string | number>) => host.ui.locale.translate(`harnessruntime.privateSessions.${key}`, values);
  const saved = detail.policy.privateSessions === true;
  const [enabled, setEnabled] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setEnabled(saved), [detail.identity.id, saved]);
  if (detail.policy.privateSessions === undefined) return null;
  const name = detail.identity.name;

  const save = async (next: boolean) => {
    setEnabled(next);
    setBusy(true);
    setError("");
    try {
      await api.put(`/api/harnesses/${encodeURIComponent(detail.identity.id)}/private-sessions`, { enabled: next });
    } catch (cause) {
      setEnabled(!next);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <>
    <Row label={t("label")} hint={canManage ? t("hint", { name }) : host.ui.locale.translate("harnessruntime.settings.ownerOnly")}>
      <Switch label={t("switch", { name })} checked={enabled} disabled={busy || !canManage} onChange={(value) => void save(value)} />
    </Row>
    {error && <Notice tone="error" role="alert">{error}</Notice>}
  </>;
}
