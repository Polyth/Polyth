// Result notifications: what a press from a rail launcher or a toolbar widget
// shows instead of opening anything. One notification per run, drawn by the
// host's shared stack (`host.notifications`) — the action's glyph and name, a
// live status, the last lines of its output. A finished success fades out by
// itself (paused while the person is on the stack); a failure stays until it
// is closed. *Full output* opens the run in the Custom actions window.
import { useEffect, useRef, useState } from "react";
import type { WebNotificationAction, WebNotificationInput, WebNotificationKind } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { ChatIcon, CopyIcon, ExpandIcon, PlayIcon, StopIcon } from "../../../apps/web/src/components/ui/index.ts";
import type { ActionRunDto } from "../src/actionModel.ts";
import { terminalPlainText } from "../src/terminalText.ts";
import ActionGlyph from "./ActionGlyph.tsx";
import { actionHost } from "./host.ts";
import { StatusPill, useRunOutput } from "./RunSheet.tsx";
import { dismissCard, focusRun, startAction, stopRun, useActions } from "./store.ts";
import { useNow } from "./time.ts";

/** How long a finished success stays on screen. */
export const CARD_SUCCESS_MS = 6_000;
/** Output lines the card shows. */
const TAIL_LINES = 5;

/** The last few non-empty lines of a run's output, as plain text. */
export function outputTail(text: string, lines = TAIL_LINES): string {
  const plain = terminalPlainText(text).replace(/\s+$/, "");
  if (!plain) return "";
  return plain.split("\n").filter((line) => line.trim() !== "").slice(-lines).join("\n");
}

/** A card that fades out by itself: a finished success that is not stopped. */
export const cardFadesOut = (run: ActionRunDto): boolean => run.status === "succeeded" || run.status === "stopped";

/** The notification id of one run's result. */
export const resultNotificationId = (runId: string): string => `custom-action.run.${runId}`;

function ResultNotice({ runId }: { runId: string }) {
  const snapshot = useActions();
  const run = snapshot.runs.find((item) => item.id === runId);
  const action = run ? snapshot.actions.find((item) => item.id === run.actionId) : undefined;
  const output = useRunOutput(run);
  const running = run?.status === "running";
  const now = useNow(running);
  const [copied, setCopied] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = useRef<{ fades: boolean } | null>(null);
  const id = resultNotificationId(runId);

  // A run the server no longer knows (it restarted) has nothing to show.
  useEffect(() => {
    if (snapshot.status === "ready" && !run) dismissCard(runId);
  }, [snapshot.status, run, runId]);

  const host = actionHost();
  const notifications = host?.notifications;
  const fades = !!run && cardFadesOut(run);

  // An older host without the shared stack: the run opens in the Custom
  // actions window instead, so a press never ends in silence.
  const fellBack = useRef(false);
  useEffect(() => {
    if (!run || notifications || fellBack.current) return;
    fellBack.current = true;
    focusRun(run.id);
    dismissCard(runId);
  }, [run, notifications, runId]);

  useEffect(() => {
    if (!run || !notifications) return;
    const tail = output ? outputTail(output.text) : "";
    const glyphState = running ? (run.phase === "chat" ? "chat" : "running") : "idle";
    const tone = running ? "running" : run.status === "succeeded" ? "success" : run.status === "stopped" ? "neutral" : "danger";
    const kind: WebNotificationKind = running ? "progress" : run.status === "succeeded" ? "success" : run.status === "stopped" ? "info" : "error";

    const stop = async () => {
      setStopping(true);
      setError(null);
      try {
        await stopRun(run.id);
      } catch (cause) {
        setError(host?.errors.friendly(tr("customaction.run.stopFailed"), cause) ?? String(cause));
      } finally {
        setStopping(false);
      }
    };
    const copy = async () => {
      if (!output?.text) return;
      try {
        await navigator.clipboard.writeText(terminalPlainText(output.text));
        setCopied(true);
        setTimeout(() => setCopied(false), 1_600);
      } catch {
        setCopied(false);
      }
    };
    const runAgain = () => {
      if (!action) return;
      void startAction(action, { projectId: run.projectId, sessionId: host?.store.getSnapshot().activeSessionId ?? null }, { card: true })
        .catch((cause) => setError(host?.errors.friendly(tr("customaction.error.start", { name: action.name }), cause) ?? String(cause)));
    };

    const actions: WebNotificationAction[] = [];
    if (running) {
      actions.push({ label: tr("customaction.run.stop"), icon: StopIcon, keepOpen: true, busy: stopping, disabled: run.phase !== "command", run: stop });
    } else if (run.chatSessionId) {
      const chatId = run.chatSessionId;
      actions.push({ label: tr("customaction.run.openChat"), icon: ChatIcon, run: () => { void host?.conversation.openSession(chatId).catch(() => undefined); } });
    } else if (action && snapshot.canRun) {
      actions.push({ label: tr("customaction.run.again"), icon: PlayIcon, keepOpen: true, run: runAgain });
    }
    actions.push(
      {
        label: copied ? tr("customaction.run.copied") : tr("customaction.run.copy"),
        icon: CopyIcon,
        iconOnly: true,
        keepOpen: true,
        disabled: !output?.text,
        run: copy,
      },
      { label: tr("customaction.card.full"), icon: ExpandIcon, iconOnly: true, run: () => focusRun(run.id) },
    );
    const problems = [run.error, error].filter((line): line is string => !!line);

    const content: Omit<WebNotificationInput, "id" | "duration"> = {
      kind,
      title: run.name,
      icon: <ActionGlyph icon={run.icon} color={run.color} size="sm" state={glyphState} />,
      body: (
        <span className="ca-result-meta">
          <StatusPill run={run} now={now} />
          {problems.map((line, at) => <span key={at} className="ca-result-error">{line}</span>)}
        </span>
      ),
      ...(tail || running ? { excerpt: tail || tr(output ? "customaction.run.waiting" : "customaction.run.loading") } : { excerpt: undefined }),
      actions,
      dismissLabel: tr("customaction.card.dismiss"),
      data: { "custom-action-run": run.id, tone },
      onDismiss: (reason) => { if (reason !== "programmatic") dismissCard(runId); },
    };
    if (!shown.current) {
      notifications.show({ id, ...content, duration: fades ? CARD_SUCCESS_MS : "sticky" });
      shown.current = { fades };
    } else if (shown.current.fades !== fades) {
      // Finished: a success starts its countdown now; anything else stays.
      notifications.update(id, { ...content, duration: fades ? CARD_SUCCESS_MS : "sticky" });
      shown.current = { fades };
    } else {
      notifications.update(id, content);
    }
  });

  useEffect(() => () => { notifications?.dismiss(id); }, [id, notifications]);
  return null;
}

/** Mounted once through the host's `app.layers` slot; renders no DOM of its
 *  own — each run's result is a notification of the host stack. */
export default function ResultCards() {
  const { cards } = useActions();
  return <>{cards.map((runId) => <ResultNotice key={runId} runId={runId} />)}</>;
}
