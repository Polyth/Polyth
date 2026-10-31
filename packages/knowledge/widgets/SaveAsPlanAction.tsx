// Message quick action: save an assistant answer to Knowledge as a plan.
// Contributed through `session.message.actions`; the host owns placement,
// ordering and visibility, so a disabled package simply never registers it. In
// the "More" menu the host keeps this mounted without a trigger and signals a
// selection through `messageActionRequest`.
import { useEffect, useRef, useState } from "react";
import { api } from "@polyth/session/web-api";
import { resolveModelPresentation } from "@polyth/contracts/model-presentation";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { setUiError, useStore } from "../../../apps/web/src/store.ts";
import { announce } from "../../../apps/web/src/components/a11y/live.tsx";
import ChatActionButton from "../../../apps/web/src/components/ChatActionButton.tsx";
import { CheckIcon, TasksIcon } from "../../../apps/web/src/components/ui/index.ts";

export default function SaveAsPlanAction({
  text,
  projectId,
  sessionId,
  time,
  locale,
  label,
  messageActionPlacement,
  messageActionRequest,
}: {
  text: string;
  projectId: string | null;
  sessionId: string | null;
  time?: number;
  locale: string;
  label: string;
  messageActionPlacement?: unknown;
  messageActionRequest?: unknown;
}) {
  const models = useStore((state) => state.models);
  const session = useStore((state) => state.sessions.find((candidate) => candidate.id === sessionId) ?? null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inMenu = messageActionPlacement === "menu";
  const request = typeof messageActionRequest === "number" ? messageActionRequest : 0;
  const seenRequest = useRef(request);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const run = () => {
    if (!projectId || busy) return;
    const presentation = resolveModelPresentation(session?.model, models, session?.resolvedHarnessId);
    setBusy(true);
    void api.knowledgeCreate({
      projectId,
      kind: "plan",
      title: tr("knowledge.action.planTitle", { modelName: presentation.name, value: new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(new Date(time ?? Date.now())) }),
      body: text,
      ...(sessionId ? { sourceSessionId: sessionId } : {}),
    }).then(() => {
      setConfirmed(true);
      announce(tr("knowledge.action.savedAsPlan"));
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => { setConfirmed(false); timer.current = null; }, 1_000);
    }).catch((error) => {
      setUiError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      setBusy(false);
    });
  };

  useEffect(() => {
    if (request === seenRequest.current) return;
    seenRequest.current = request;
    if (inMenu) run();
    // The request counter is the only menu trigger; `run` reads the latest text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  if (inMenu || !projectId) return null;
  return (
    <ChatActionButton
      icon={confirmed ? CheckIcon : TasksIcon}
      label={label}
      className={confirmed ? "chat-action-button--confirmed" : undefined}
      busy={busy}
      data-action-id="knowledge.save-as-plan"
      onClick={run}
    />
  );
}
