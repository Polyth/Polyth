import { useEffect, useMemo, useState } from "react";
import type { SessionProjection } from "@polyth/contracts";
import { Button, Textarea } from "../../../../apps/web/src/components/ui/index.ts";
import type { HandoffClient, HandoffTarget } from "./index.ts";
import { hashText } from "./index.ts";
import { noteNewSessionHandoffPending } from "../../src/newSessionProvenance.ts";
import { deriveSessionTargetLabel } from "./format.ts";
import { englishHandoff, type HandoffTranslate } from "./i18n.ts";
import { provenanceActionForTarget } from "./provenanceAction.ts";
import { resolveInitialHandoffTarget } from "./resolveInitialHandoffTarget.ts";
import { SurfaceDrawer } from "./SurfaceDrawer.tsx";

export function SendSheet(props: {
  client: HandoffClient;
  projectId: string;
  session: SessionProjection | null;
  sessionId: string | null;
  harnessName?: string | null;
  models?: readonly import("@polyth/contracts").ModelDescriptor[];
  text: string;
  preferredTarget?: HandoffTarget;
  provenance?: import("@polyth/contracts").HandoffResultImportedData["provenance"];
  translate?: HandoffTranslate;
  onClose(): void;
}) {
  const t = props.translate ?? englishHandoff;
  const [text, setText] = useState(props.text);
  const availableTargets = useMemo(
    () => props.client.listTargets().map((item) => item.id),
    [props.client, props.session],
  );
  const initialTarget = resolveInitialHandoffTarget({
    preferredTarget: props.preferredTarget,
    session: props.session,
    availableTargets,
    fallbackTarget: props.client.defaultTarget(props.session),
  });
  const [target, setTarget] = useState<HandoffTarget>(initialTarget);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const working = props.session?.status === "working";
  const sessionLabel = deriveSessionTargetLabel(props.session, props.harnessName ?? null, props.models ?? [], t);
  const targets = props.client.listTargets();
  const queueTarget = targets.find((item) => item.id === "queue");

  useEffect(() => {
    setText(props.text);
    setTarget(resolveInitialHandoffTarget({
      preferredTarget: props.preferredTarget,
      session: props.session,
      availableTargets: props.client.listTargets().map((item) => item.id),
      fallbackTarget: props.client.defaultTarget(props.session),
    }));
  }, [props.text, props.session, props.client, props.preferredTarget]);

  const send = async () => {
    setBusy(true);
    setError("");
    try {
      await props.client.executeTarget(target, props.projectId, props.sessionId, text);
    } catch (cause) {
      // Nothing was delivered: keep the sheet and the text for another try.
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
      return;
    }
    // Delivered. The sheet closes even if recording provenance fails, so a
    // second press can never send the same text twice.
    props.onClose();
    if (props.provenance) {
      const action = provenanceActionForTarget(target);
      if (action === "pending-new-session") {
        noteNewSessionHandoffPending(props.projectId, props.provenance, text);
      } else if (action === "record-session" && props.sessionId) {
        await props.client.recordImport(props.sessionId, props.provenance, hashText(text))
          .catch((cause: unknown) => console.warn("handoff provenance was not recorded", cause));
      }
    }
  };

  const currentTarget: HandoffTarget = working ? "queue" : "current-session";
  const sendLabel = target === "draft"
    ? t("handoff.send.saveDraft")
    : target === "queue" || working ? t("handoff.send.queue") : t("handoff.send.send");

  return (
    <SurfaceDrawer title={t("handoff.send.title")} onClose={props.onClose} translate={t}>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} aria-label={t("handoff.send.textAria")} />
      <fieldset className="handoff-target-fieldset">
        <legend>{t("handoff.send.destination")}</legend>
        <div className="handoff-target-options" role="radiogroup" aria-label={t("handoff.send.destination")}>
          {sessionLabel && targets.some((item) => item.id === currentTarget) ? (
            <label className={`handoff-target-option${target === currentTarget ? " is-selected" : ""}`}>
              <input
                type="radio"
                name="handoff-target"
                checked={target === currentTarget}
                onChange={() => setTarget(currentTarget)}
              />
              <span className="handoff-target-copy">
                <strong>{working ? t("handoff.send.queueCurrent") : t("handoff.send.sendCurrent")}</strong>
                <span className="handoff-target-meta">{sessionLabel}</span>
              </span>
            </label>
          ) : null}
          {!working && queueTarget ? (
            <label className={`handoff-target-option${target === "queue" ? " is-selected" : ""}`}>
              <input
                type="radio"
                name="handoff-target"
                checked={target === "queue"}
                onChange={() => setTarget("queue")}
              />
              <span className="handoff-target-copy">
                <strong>{t("handoff.send.queueCurrent")}</strong>
                <span className="handoff-target-meta">{sessionLabel ?? t("handoff.send.idleSession")}</span>
              </span>
            </label>
          ) : null}
          {targets.filter((item) => item.id === "new-session" || item.id === "draft").map((item) => (
            <label key={item.id} className={`handoff-target-option${target === item.id ? " is-selected" : ""}`}>
              <input
                type="radio"
                name="handoff-target"
                checked={target === item.id}
                onChange={() => setTarget(item.id)}
              />
              <span className="handoff-target-copy"><strong>{item.label}</strong></span>
            </label>
          ))}
        </div>
      </fieldset>
      {error ? <p className="handoff-error" role="alert">{error}</p> : null}
      <div className="handoff-actions">
        <Button onClick={() => void send()} disabled={busy || !text.trim()}>
          {sendLabel}
        </Button>
        <Button variant="ghost" onClick={props.onClose}>{t("handoff.send.cancel")}</Button>
      </div>
    </SurfaceDrawer>
  );
}
