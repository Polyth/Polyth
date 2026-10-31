import { useState } from "react";
import type { HarnessSnapshot, HarnessUpdateStatus } from "@polyth/contracts";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { formatRelativeTime } from "@polyth/web/i18n";
import { invalidateRuntimeCatalogs } from "@polyth/models/runtime-catalog";
import { Button, DownloadIcon, Notice, RefreshIcon } from "../../../apps/web/src/components/ui/index.ts";
import { ReadonlyRow, Row, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { displayVersion } from "./presentation.ts";
import { runHarnessUpdate, useHarnessUpdates } from "./updates.ts";

const api = createApiTransport();

type RestartResult = { restarted: number; failed: number };
type Action = "restart" | "refresh-models";

/** "4 minutes ago" for a release lookup time. */
function checkedAgo(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 60) return formatRelativeTime(-Math.max(0, minutes), "minute", { numeric: "auto" });
  const hours = Math.round(minutes / 60);
  return hours < 48 ? formatRelativeTime(-hours, "hour", { numeric: "auto" }) : formatRelativeTime(-Math.round(hours / 24), "day", { numeric: "auto" });
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

function latestRelease(status: HarnessUpdateStatus | undefined, loading: boolean, t: Translate): string {
  if (!status) return loading ? t("checking") : t("notChecked");
  const latest = displayVersion(status.latest);
  const when = status.checkedAt ? checkedAgo(status.checkedAt) : undefined;
  if (status.available && latest) return when ? t("availableChecked", { version: latest, when }) : t("available", { version: latest });
  if (latest) return when ? t("upToDateChecked", { when }) : t("upToDate");
  switch (status.reason) {
    case "remote": return t("reason.remote");
    case "bundled": return t("reason.bundled");
    case "not-installed": return t("reason.notInstalled");
    case "unavailable": return t("reason.unavailable");
    case "unparsed": return t("reason.unparsed");
    default: return t("reason.unpublished");
  }
}

/** Splits a translated sentence at {command} so the command renders as code. */
const MARK = "\u0001";
function withCommand(text: string, command: string) {
  const [before = "", after = ""] = text.split(MARK);
  return <>{before}<code>{command}</code>{after}</>;
}

/** Version and runtime maintenance for one harness: its CLI's own updater,
 *  a restart of its live runtimes, and a fresh model list. */
export default function HarnessMaintenance({ host, harnessId, snapshot, projectId, canManage = true }: {
  host: WebPackageHost;
  harnessId: string;
  snapshot?: HarnessSnapshot;
  projectId?: string | null;
  canManage?: boolean;
}) {
  const t: Translate = (key, values) => host.ui.locale.translate(`harnessruntime.maintenance.${key}`, values);
  const updates = useHarnessUpdates(projectId);
  const status = updates.statuses.get(harnessId);
  const run = updates.runs.get(harnessId);
  const [busy, setBusy] = useState<Action | undefined>();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const updateCommand = snapshot?.setup?.updateCommand;
  const name = snapshot?.identity.name ?? harnessId;
  const path = `/api/harnesses/${encodeURIComponent(harnessId)}`;
  const installed = displayVersion(status?.current ?? snapshot?.identity.version);
  const latest = displayVersion(status?.latest);
  const running = run?.state === "running";
  // The server decides who may run an updater (the instance owner, on this
  // machine); without its answer the attempt is allowed and it explains.
  const mayUpdate = status ? status.canUpdate : Boolean(updateCommand);

  const act = async (action: Action) => {
    setBusy(action);
    setConfirm(false);
    setError("");
    setNotice("");
    try {
      if (action === "restart") {
        const result = await api.post<RestartResult>(`${path}/restart`, {});
        if (result.failed) setError(t("restartPartial", { failed: result.failed, restarted: result.restarted }));
        else setNotice(result.restarted ? t("restarted", { count: result.restarted }) : t("noneRunning"));
      } else {
        const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
        const result = await api.post<HarnessSnapshot | null>(`${path}/refresh-models${query}`, {});
        const count = result?.catalog?.models?.length;
        setNotice(count === undefined ? t("modelsRefreshed") : t("modelsRefreshedCount", { count }));
      }
      // The server dropped its snapshot and model caches; drop the page's too
      // so this page's version and every model picker re-read.
      invalidateRuntimeCatalogs();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t(action === "restart" ? "restartFailed" : "refreshFailed", { name }));
    } finally {
      setBusy(undefined);
    }
  };

  return <div className="pkg-harnesses-runtime" data-settings-item={`harness.${harnessId}.runtime`}>
    <Section title={t("version")} hint={t("versionHint", { name })}
      action={<Button size="sm" variant="ghost" iconStart={RefreshIcon} busy={updates.loading} onClick={() => void updates.refresh(true)}>{t("checkUpdates")}</Button>}>
      <ReadonlyRow label={t("installed")} value={installed ?? t("notReported")} />
      <ReadonlyRow label={t("latest")} value={latestRelease(status, updates.loading, t)} />
      {updateCommand && <Row label={status?.available && latest ? t("updateTo", { version: latest }) : t("update")}
        hint={<>{withCommand(t("updateHint", { command: MARK }), updateCommand)}{!mayUpdate && status?.reason !== "remote" ? ` ${t("updateOwnerOnly")}` : ""}</>}>
        <Button size="sm" iconStart={DownloadIcon} busy={running} disabled={!mayUpdate || running}
          onClick={() => void runHarnessUpdate(harnessId, projectId)}>{running ? t("updating") : status?.available ? t("update") : t("runUpdater")}</Button>
      </Row>}
      {run?.state === "failed" && run.output && <details className="pkg-harnesses-update-log" open><summary>{t("updaterOutput")}</summary><pre>{run.output}</pre></details>}
      {run?.state === "done" && run.output && <details className="pkg-harnesses-update-log"><summary>{t("updaterOutput")}</summary><pre>{run.output}</pre></details>}
    </Section>
    <Section title={t("runtime")} hint={t("runtimeHint")}>
      <Row label={t("restartLabel")} hint={canManage ? t("restartHint") : t("restartOwnerOnly")}>
        {confirm
          ? <span className="pkg-harnesses-confirm" role="group" aria-label={t("restartLabel")}>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>{t("cancel")}</Button>
            <Button size="sm" variant="danger" busy={busy === "restart"} onClick={() => void act("restart")}>{t("restartNow")}</Button>
          </span>
          : <Button size="sm" disabled={Boolean(busy) || !canManage} onClick={() => setConfirm(true)}>{t("restart")}</Button>}
      </Row>
      <Row label={t("refreshModels")} hint={t("refreshModelsHint")}>
        <Button size="sm" iconStart={RefreshIcon} busy={busy === "refresh-models"} disabled={Boolean(busy)} onClick={() => void act("refresh-models")}>{t("refresh")}</Button>
      </Row>
      {error ? <Notice tone="error" role="alert">{error}</Notice> : null}
      {notice ? <Notice tone="success" role="status">{notice}</Notice> : null}
    </Section>
  </div>;
}
