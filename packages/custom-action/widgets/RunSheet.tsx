// One run's live result: status, the command, its output streamed in as it
// arrives, and what to do next (stop, run again, copy, ask an agent, open the
// chat it started). Anchored to the pressed icon on desktop, a sheet on phone.
import { useEffect, useRef, useState, type RefObject } from "react";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  Button,
  ChatIcon,
  CopyIcon,
  EditIcon,
  IconButton,
  NewChatIcon,
  PlayIcon,
  ResponsiveOverlay,
  Spinner,
  StopIcon,
} from "../../../apps/web/src/components/ui/index.ts";
import type { ActionRunDto, CustomActionDto } from "../src/actionModel.ts";
import { outputBlock } from "../src/chatPrompt.ts";
import { terminalPlainText } from "../src/terminalText.ts";
import { actionApi } from "./api.ts";
import ActionGlyph from "./ActionGlyph.tsx";
import { actionHost } from "./host.ts";
import { markSeen, stopRun, useActions } from "./store.ts";
import TerminalOutput from "./TerminalOutput.tsx";
import { duration, stopwatch, useNow } from "./time.ts";

const OUTPUT_KEEP = 400_000;

interface OutputState {
  runId: string;
  text: string;
  end: number;
  cut: boolean;
  command: string;
  error: string | null;
}

/** Stream one run's output with incremental reads while it runs. */
export function useRunOutput(run: ActionRunDto | undefined): OutputState | null {
  const [state, setState] = useState<OutputState | null>(null);
  const runId = run?.id ?? null;
  const running = run?.status === "running";
  const end = run?.outputEnd ?? 0;
  const cursor = useRef({ runId: "", end: 0, busy: false });

  useEffect(() => {
    if (!runId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (cursor.current.runId !== runId) {
      cursor.current = { runId, end: 0, busy: false };
      setState(null);
    }
    const read = async () => {
      if (cursor.current.busy) return;
      cursor.current.busy = true;
      try {
        const page = await actionApi.output(runId, cursor.current.end);
        if (!alive || cursor.current.runId !== runId) return;
        const gap = page.start > cursor.current.end;
        cursor.current.end = page.end;
        setState((current) => {
          const base = current && current.runId === runId && !gap ? current.text : "";
          const text = (base + page.text).slice(-OUTPUT_KEEP);
          return {
            runId,
            text,
            end: page.end,
            cut: (current?.runId === runId && current.cut) || gap || page.run.truncated || base.length + page.text.length > OUTPUT_KEEP,
            command: page.command,
            error: null,
          };
        });
      } catch (cause) {
        if (!alive) return;
        setState((current) => current && current.runId === runId
          ? { ...current, error: cause instanceof Error ? cause.message : String(cause) }
          : { runId, text: "", end: 0, cut: false, command: "", error: cause instanceof Error ? cause.message : String(cause) });
      } finally {
        cursor.current.busy = false;
      }
      if (alive && running) timer = setTimeout(() => void read(), 700);
    };
    void read();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // `end` re-reads once more when the run's final length moves on.
  }, [runId, running, end]);

  return state && state.runId === runId ? state : null;
}

export function StatusPill({ run, now }: { run: ActionRunDto; now: number }) {
  const elapsed = (run.finishedAt ?? now) - run.startedAt;
  if (run.status === "running") {
    return (
      <span className="ca-pill" data-tone="running" role="status">
        <Spinner size="sm" />
        {run.phase === "chat" ? tr("customaction.status.startingChat") : tr("customaction.status.running")}
        <span className="ca-pill-time">{stopwatch(elapsed)}</span>
      </span>
    );
  }
  const tone = run.status === "succeeded" ? "success" : run.status === "stopped" ? "neutral" : run.status === "timed-out" ? "warning" : "danger";
  const label = run.status === "succeeded"
    ? run.chatSessionId ? tr("customaction.status.chatStarted") : tr("customaction.status.done")
    : run.status === "failed" ? tr("customaction.status.exitCode", { code: String(run.exitCode ?? "?") })
    : run.status === "stopped" ? tr("customaction.status.stopped")
    : run.status === "timed-out" ? tr("customaction.status.timedOut")
    : tr("customaction.status.error");
  return (
    <span className="ca-pill" data-tone={tone} role="status">
      <i className="ca-pill-dot" aria-hidden="true" />
      {label}
      <span className="ca-pill-time">{duration(elapsed)}</span>
    </span>
  );
}

export default function RunSheet({
  runId,
  anchorRef,
  onClose,
  onEdit,
  onRunAgain,
}: {
  runId: string | null;
  anchorRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onEdit?: (action: CustomActionDto) => void;
  onRunAgain?: (action: CustomActionDto, run: ActionRunDto) => void;
}) {
  const snapshot = useActions();
  const run = runId ? snapshot.runs.find((item) => item.id === runId) : undefined;
  const action = run ? snapshot.actions.find((item) => item.id === run.actionId) : undefined;
  const output = useRunOutput(run);
  const running = run?.status === "running";
  const now = useNow(running);
  const phone = useShellMode() === "phone";
  const presentation = phone ? "sheet" : anchorRef ? "popover" : "dialog";
  const [copied, setCopied] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  useEffect(() => {
    if (run && run.status !== "running") markSeen(run.id);
  }, [run?.id, run?.status]);

  if (!runId) return null;
  const host = actionHost();
  const title = run?.name ?? tr("customaction.run.title");

  const copy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(terminalPlainText(output.text));
      setCopied(true);
      setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
    }
  };

  const stop = async () => {
    if (!run) return;
    setStopping(true);
    setStopError(null);
    try {
      await stopRun(run.id);
    } catch (cause) {
      setStopError(host?.errors.friendly(tr("customaction.run.stopFailed"), cause) ?? String(cause));
    } finally {
      setStopping(false);
    }
  };

  const askAgent = () => {
    if (!run || !output || !host) return;
    const draft = `${outputBlock({
      actionName: run.name,
      command: output.command,
      output: output.text,
      outputTruncated: output.cut,
      status: run.status,
      exitCode: run.exitCode,
      durationMs: (run.finishedAt ?? Date.now()) - run.startedAt,
    })}\n\n`;
    onClose();
    host.conversation.startNewSession(run.projectId, { draft });
  };

  const openChat = () => {
    if (!run?.chatSessionId || !host) return;
    onClose();
    void host.conversation.openSession(run.chatSessionId).catch(() => undefined);
  };

  const footer = run && (
    <div className="ca-run-actions">
      {running ? (
        <Button size="sm" variant="danger" iconStart={StopIcon} busy={stopping} disabled={run.phase !== "command"} onClick={() => void stop()}>
          {tr("customaction.run.stop")}
        </Button>
      ) : (
        <>
          {run.chatSessionId && (
            <Button size="sm" variant="primary" iconStart={ChatIcon} onClick={openChat}>{tr("customaction.run.openChat")}</Button>
          )}
          {action && onRunAgain && (
            <Button size="sm" variant={run.chatSessionId ? "quiet" : "primary"} iconStart={PlayIcon} onClick={() => onRunAgain(action, run)}>
              {tr("customaction.run.again")}
            </Button>
          )}
          {snapshot.canChat && !run.chatSessionId && output && (
            <Button size="sm" variant="quiet" iconStart={NewChatIcon} onClick={askAgent}>{tr("customaction.run.askAgent")}</Button>
          )}
        </>
      )}
      <span className="ca-run-actions-spacer" />
      <IconButton
        icon={CopyIcon}
        size="sm"
        label={copied ? tr("customaction.run.copied") : tr("customaction.run.copy")}
        className={copied ? "ca-copy is-copied" : "ca-copy"}
        disabled={!output?.text}
        onClick={() => void copy()}
      />
      {action && onEdit && snapshot.canManage && (
        <IconButton icon={EditIcon} size="sm" label={tr("customaction.edit")} onClick={() => { onClose(); onEdit(action); }} />
      )}
    </div>
  );

  return (
    <ResponsiveOverlay
      open
      onClose={onClose}
      title={title}
      {...(anchorRef ? { anchorRef } : {})}
      desktop={anchorRef ? "popover" : "dialog"}
      phone="sheet"
      sheetSize="tall"
      dialogSize="lg"
      align="center"
      className="ca-run-surface"
    >
      <div className="ca-run" data-presentation={presentation}>
        {!run ? (
          <p className="ca-run-gone">{tr("customaction.run.gone")}</p>
        ) : (
          <>
            <header className="ca-run-head">
              <ActionGlyph icon={run.icon} color={run.color} size="md" state={running ? (run.phase === "chat" ? "chat" : "running") : "idle"} />
              <div className="ca-run-heading">
                {presentation === "popover" && <strong className="ca-run-name">{run.name}</strong>}
                <code className="ca-run-command" title={output?.command}>{output?.command.split("\n")[0] ?? " "}</code>
              </div>
              <StatusPill run={run} now={now} />
            </header>
            {run.error && <p className="ca-run-error" role="alert">{run.error}</p>}
            {stopError && <p className="ca-run-error" role="alert">{stopError}</p>}
            {run.chatSkipped && <p className="ca-run-note">{tr("customaction.run.chatSkipped")}</p>}
            {output?.cut && <p className="ca-run-note">{tr("customaction.run.cut")}</p>}
            <TerminalOutput
              text={output?.text ?? ""}
              live={running}
              label={tr("customaction.run.output")}
              emptyLabel={output ? tr(running ? "customaction.run.waiting" : "customaction.run.noOutput") : tr("customaction.run.loading")}
            />
            {output?.error && <p className="ca-run-error" role="alert">{output.error}</p>}
            {footer}
          </>
        )}
      </div>
    </ResponsiveOverlay>
  );
}
