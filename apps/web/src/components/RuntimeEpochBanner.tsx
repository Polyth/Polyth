import { useEffect, useState } from "react";
import type { SessionDebugDto, SessionEvent, SessionProjection } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { registerSlot } from "../slots.ts";
import { setUiError, upsertSession, useActiveModel, useStore } from "../store.ts";
import { friendlyError } from "../settings.ts";
import { tr } from "../i18n/index.ts";
import { runtimeDiagnosticFacts, uncertainRecoveryWarning } from "../runtimeDiagnostics.ts";
import Button from "./ui/Button.tsx";

const EMPTY_EVENTS: never[] = [];

function RuntimeRecoveryDetails({
  sessionId,
  session,
  events,
}: {
  sessionId: string;
  session: SessionProjection;
  events: readonly SessionEvent[];
}) {
  const [open, setOpen] = useState(false);
  const [debug, setDebug] = useState<SessionDebugDto | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api.sessionDebug(sessionId).then((row) => {
      if (!cancelled) setDebug(row.debug);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [open, sessionId]);

  const facts = runtimeDiagnosticFacts({
    status: session.status,
    runtimeControl: session.runtimeControl,
    binding: session.runtimeBinding,
    events,
    debug,
  });

  return (
    <details
      className="runtime-recovery-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{tr("runtimeRecovery.technicalDetails")}</summary>
      <dl className="runtime-recovery-facts">
        {facts.map((fact) => (
          <div key={fact.label} className="runtime-recovery-fact">
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function RuntimeEpochBanner({ sessionId }: { sessionId: string }) {
  const session = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === sessionId) ?? null);
  const events = useStore((state) => state.events[sessionId] ?? EMPTY_EVENTS);
  const model = useActiveModel();
  const [busy, setBusy] = useState(false);
  const [completedFor, setCompletedFor] = useState<string | null>(null);
  const [debug, setDebug] = useState<SessionDebugDto | null>(null);

  useEffect(() => {
    if (completedFor !== sessionId) return;
    if (session?.status === "working") setCompletedFor(null);
  }, [completedFor, sessionId, session?.status]);

  useEffect(() => {
    if (session?.status !== "epoch-pending" || session.runtimeControl === "owned") return;
    let cancelled = false;
    void api.sessionDebug(sessionId).then((row) => {
      if (!cancelled) setDebug(row.debug);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [sessionId, session?.status, session?.runtimeControl]);

  if (!session) return null;

  if (session.status !== "epoch-pending") {
    if (completedFor === sessionId) {
      return (
        <div className="runtime-recovery" role="status">
          <p className="runtime-recovery-note">{tr("runtimeRecovery.completed")}</p>
          <RuntimeRecoveryDetails sessionId={sessionId} session={session} events={events} />
        </div>
      );
    }
    return null;
  }

  // Owned runtimes recover their epoch in the background. Only borrowed
  // runtimes need a user-facing confirmation before changing identity.
  if (session.runtimeControl === "owned") return null;

  const turnActive = model.turn?.status === "working";
  const hasUncertainTurn = uncertainRecoveryWarning({ events, debug });

  if (session.runtimeControl !== "borrowed") {
    return (
      <div className="runtime-recovery" role="status">
        <p className="runtime-recovery-title">{tr("sessionStatus.runtimeChanged")}</p>
        <RuntimeRecoveryDetails sessionId={sessionId} session={session} events={events} />
      </div>
    );
  }

  const confirm = async () => {
    if (busy || turnActive) return;
    setBusy(true);
    try {
      const ready = await api.confirmBorrowedRuntimeEpoch(sessionId);
      upsertSession(ready);
      setCompletedFor(sessionId);
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="runtime-recovery" role="status">
      <p className="runtime-recovery-title">{tr("runtimeRecovery.borrowedTitle")}</p>
      <p className="runtime-recovery-detail">{tr("runtimeRecovery.borrowedDetail")}</p>
      {turnActive && <p className="runtime-recovery-note">{tr("runtimeRecovery.busy")}</p>}
      {hasUncertainTurn && (
        <p className="runtime-recovery-note">{tr("runtimeRecovery.uncertainTurn")}</p>
      )}
      <p className="runtime-recovery-note">{tr("runtimeRecovery.leaveBlocked")}</p>
      <div className="runtime-recovery-actions">
        <Button
          variant="primary"
          size="sm"
          busy={busy}
          disabled={turnActive}
          onClick={() => void confirm()}
        >
          {tr("runtimeRecovery.confirm")}
        </Button>
      </div>
      <RuntimeRecoveryDetails sessionId={sessionId} session={session} events={events} />
    </div>
  );
}

let installed = false;

export function installRuntimeEpochBanner(): void {
  if (installed) return;
  installed = true;
  registerSlot(
    "session.composer.before",
    "session.runtime-epoch-recovery",
    (ctx) => {
      const sessionId = typeof ctx.sessionId === "string" ? ctx.sessionId : "";
      if (!sessionId) return null;
      return <RuntimeEpochBanner sessionId={sessionId} />;
    },
    -50,
  );
}
