import { useEffect, useId, useState } from "react";
import type { BrowserVaultFillRequestDto } from "@polyth/session/web-api";
import { api } from "@polyth/session/web-api";
import { Button, Checkbox } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { BROWSER_RESYNC_INTERVAL_MS, changesVaultFillRequests, subscribeBrowserSessionEvents } from "./browserSignals.ts";

export default function CredentialFillApprovalCard({
  projectId,
  sessionId,
}: {
  projectId: string | null;
  sessionId: string | null;
}) {
  const [request, setRequest] = useState<BrowserVaultFillRequestDto | null>(null);
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState<"allow" | "allow-always" | "deny" | null>(null);
  const [error, setError] = useState("");
  const titleId = useId();

  useEffect(() => {
    if (!projectId || !sessionId) {
      setRequest(null);
      return;
    }
    let cancelled = false;
    let loading = false;
    let again = false;
    const load = async (): Promise<void> => {
      // Coalesce: a signal during a load schedules exactly one more load.
      if (loading) { again = true; return; }
      loading = true;
      try { await loadOnce(); } finally {
        loading = false;
        if (again && !cancelled) { again = false; await load(); }
      }
    };
    const loadOnce = async () => {
      const sessions = await api.browserList(projectId);
      const linked = sessions.filter((candidate) =>
        candidate.sessionId === sessionId && candidate.status !== "closed");
      const requests = (await Promise.all(
        linked.map((candidate) => api.browserVaultFillRequests(candidate.id)),
      )).flat();
      if (cancelled) return;
      const next = requests[0] ?? null;
      setRequest((current) => current?.id === next?.id ? current : next);
      if (!next) {
        setAlways(false);
        setBusy(null);
        setError("");
      }
    };
    void load().catch(() => {});
    // The request/resolution facts are session events; reload on them. The
    // slow resync only covers a missed event (e.g. across a reconnect).
    const off = subscribeBrowserSessionEvents((event) => {
      if (changesVaultFillRequests(event, sessionId)) void load().catch(() => {});
    });
    const timer = setInterval(() => void load().catch(() => {}), BROWSER_RESYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      off();
      clearInterval(timer);
    };
  }, [projectId, sessionId]);

  const reply = async (decision: "allow" | "allow-always" | "deny") => {
    if (!request || busy) return;
    setBusy(decision);
    setError("");
    try {
      await api.browserVaultFillDecision(request.id, decision);
      setRequest(null);
      setAlways(false);
      setBusy(null);
    } catch {
      setBusy(null);
      setError(tr("browser.vaultFill.answerFailed"));
    }
  };

  if (!request) return null;
  const selectedDecision = always ? "allow-always" : "allow";

  return (
    <section className="browser-vault-fill-card" aria-labelledby={titleId}>
      <div className="browser-vault-fill-card-head">
        <div>
          <div className="eyebrow">{tr("browser.vaultFill.securityRequest")}</div>
          <h3 id={titleId}>{tr("browser.vaultFill.title")}</h3>
        </div>
        <span className="browser-vault-fill-card-mark" aria-hidden="true">●</span>
      </div>
      <p className="browser-vault-fill-card-copy">
        {tr("browser.vaultFill.allow", { label: request.label || request.handle, origin: request.origin })}
      </p>
      <div className="browser-vault-fill-card-target">
        <code>{request.handle}</code>
        <span aria-hidden="true">→</span>
        <code>{request.selector}</code>
      </div>
      <Checkbox
        checked={always}
        disabled={busy !== null}
        onChange={setAlways}
        label={tr("browser.vaultFill.alwaysAllow")}
        description={tr("browser.vaultFill.alwaysAllowDescription")}
      />
      <p className="browser-vault-fill-card-note">{tr("browser.vaultFill.serverSideNote")}</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="browser-vault-fill-card-actions">
        <Button size="sm" disabled={busy !== null} busy={busy === "deny"} onClick={() => void reply("deny")}>
          {tr("browser.vaultFill.deny")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy !== null}
          busy={busy === selectedDecision}
          onClick={() => void reply(selectedDecision)}
        >
          {always ? tr("browser.vaultFill.allowAlways") : tr("browser.vaultFill.allowOnce")}
        </Button>
      </div>
    </section>
  );
}
