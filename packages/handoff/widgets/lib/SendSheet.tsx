import { useEffect, useMemo, useState } from "react";
import type { SessionProjection } from "@polyth/contracts";
import { Button, Textarea } from "../../../../apps/web/src/components/ui/index.ts";
import type { HandoffClient, HandoffTarget } from "./index.ts";
import { hashText } from "./index.ts";
import { noteNewSessionHandoffPending } from "../../src/newSessionProvenance.ts";
import { deriveSessionTargetLabel } from "./format.ts";
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
  onClose(): void;
}) {
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
  const working = props.session?.status === "working";
  const sessionLabel = deriveSessionTargetLabel(props.session, props.harnessName ?? null, props.models ?? []);
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
    try {
      await props.client.executeTarget(target, props.projectId, props.sessionId, text);
      if (props.provenance) {
        const action = provenanceActionForTarget(target);
        if (action === "pending-new-session") {
          noteNewSessionHandoffPending(props.projectId, props.provenance, text);
        } else if (action === "record-session" && props.sessionId) {
          await props.client.recordImport(props.sessionId, props.provenance, hashText(text));
        }
      }
      props.onClose();
    } finally {
      setBusy(false);
    }
  };

  const currentTarget: HandoffTarget = working ? "queue" : "current-session";
  const sendLabel = target === "draft" ? "Save draft" : target === "queue" ? "Queue" : working ? "Queue" : "Send";

  return (
    <SurfaceDrawer title="Send to Polyth" onClose={props.onClose}>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} aria-label="Handoff text" />
      <fieldset className="handoff-target-fieldset">
        <legend>Destination</legend>
        <div className="handoff-target-options" role="radiogroup" aria-label="Destination">
          {sessionLabel && targets.some((item) => item.id === currentTarget) ? (
            <label className={`handoff-target-option${target === currentTarget ? " is-selected" : ""}`}>
              <input
                type="radio"
                name="handoff-target"
                checked={target === currentTarget}
                onChange={() => setTarget(currentTarget)}
              />
              <span className="handoff-target-copy">
                <strong>{working ? "Queue in current session" : "Send to current session"}</strong>
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
                <strong>Queue in current session</strong>
                <span className="handoff-target-meta">{sessionLabel ?? "Idle session"}</span>
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
      <div className="handoff-actions">
        <Button onClick={() => void send()} disabled={busy || !text.trim()}>
          {sendLabel}
        </Button>
        <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
      </div>
    </SurfaceDrawer>
  );
}
