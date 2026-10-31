import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { assistFreshnessSeq, latestCompletedExchange } from "@polyth/session/next-action";
import { createApiTransport, type ComposerDraftContext, type WebPackageHost } from "@polyth/web-sdk";
import { AssistIcon, IconButton, Tooltip, UndoIcon } from "../../../apps/web/src/components/ui/index.ts";
import {
  canApplyPromptRewrite, canRevertPromptRewrite, nextActionInsertMode, promptRewriteSource,
  type PromptRewrite, type PromptRewriteRequest,
} from "./promptRewrite.ts";
import { requestNextPrompt } from "./NextPromptSource.tsx";

const api = createApiTransport();
const QUIET_CODES = ["stale", "no-completed-exchange", "in-flight"];

/** The rail button: improve a draft, or — on an empty composer — ask for the
 * next prompt now. Automatic suggestions do not live here but in
 * `NextPromptSource`, so hiding or moving this button never turns them off. */
export default function PromptAssist({ host, draft }: { host: WebPackageHost; draft: ComposerDraftContext }) {
  const [busy, setBusy] = useState(false);
  const [rewrite, setRewrite] = useState<PromptRewrite | null>(null);
  const flight = useRef(0);
  const pending = useRef(false);
  const alive = useRef(true);
  const tr = host.ui.locale.translate;
  const sessionId = draft.sessionId;
  // Re-render when the conversation completes an exchange, without a composer render.
  const conversation = () => sessionId ? assistFreshnessSeq(host.sessions.events(sessionId)) : 0;
  useSyncExternalStore(host.sessions.subscribe, conversation, conversation);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; flight.current += 1; };
  }, []);

  const scopeId = sessionId ?? draft.projectId ?? "";
  useEffect(() => {
    setRewrite((current) => current?.scopeId === scopeId && current.generated === draft.text ? current : null);
  }, [scopeId, draft.text]);
  const hasText = !!draft.text.trim();
  const hasCompletedExchange = () => !!sessionId && latestCompletedExchange(host.sessions.events(sessionId)) !== null;
  const canRevert = !!scopeId && canRevertPromptRewrite(scopeId, draft.text, rewrite) && !busy;
  const canGenerate = !!scopeId && !draft.busy && !busy && (hasText || hasCompletedExchange());
  const label = canRevert ? tr("timeline.regenerate")
    : hasText ? tr("composer.improvePrompt") : tr("composer.generateNextAction");

  const fail = (error: unknown) => {
    if (QUIET_CODES.includes((error as { code?: string }).code ?? "")) return;
    host.errors.show?.(host.errors.friendly(tr("composer.couldNotGenerateNextAction"), error));
  };

  /** Ask for the next message now: progress on the button, the answer on the
   * host's suggestion chip ahead of a harness hint, a notice on failure. */
  const suggestNext = (id: string, atSeq: number) => {
    pending.current = true;
    setBusy(true);
    void requestNextPrompt(host, id, atSeq, true)
      .then((suggestion) => {
        if (!alive.current || suggestion === null) return;
        if (!suggestion) {
          host.errors.show?.(tr("composer.noNextPromptSuggested"), undefined, { kind: "info" });
          return;
        }
        // A host without the suggestion chip still gets the draft, as before.
        const now = draft.read();
        if (!draft.offerSuggestion && now.sessionId === id && !now.text.trim() && nextActionInsertMode(suggestion)) {
          draft.replace(suggestion);
        }
      })
      .catch((error) => {
        if (alive.current) fail(error);
      })
      .finally(() => {
        if (!alive.current) return;
        pending.current = false;
        setBusy(false);
      });
  };

  const improve = () => {
    const current = draft.read();
    const scope = current.sessionId ?? current.projectId;
    if (!scope) return;
    const source = promptRewriteSource(scope, current.text, rewrite);
    const request: PromptRewriteRequest = {
      sessionId: current.sessionId, projectId: current.projectId,
      draftRevision: current.revision, draft: current.text,
    };
    const token = ++flight.current;
    pending.current = true;
    setBusy(true);
    const path = current.sessionId
      ? `/api/sessions/${encodeURIComponent(current.sessionId)}/assist/suggestion`
      : `/api/projects/${encodeURIComponent(current.projectId!)}/assist/prompt`;
    void api.post<{ suggestion: string; atSeq: number }>(path, { draft: source })
      .then((result) => {
        if (flight.current !== token) return;
        const now = draft.read();
        if (now.text !== request.draft || !nextActionInsertMode(result.suggestion)
          || !canApplyPromptRewrite(request, {
            activeSessionId: now.sessionId, activeProjectId: now.projectId, draftRevision: now.revision,
          })) return;
        draft.replace(result.suggestion);
        setRewrite({ scopeId: scope, original: source, generated: result.suggestion });
      })
      .catch((error) => {
        if (flight.current !== token) return;
        fail(error);
      })
      .finally(() => {
        if (flight.current !== token) return;
        pending.current = false;
        setBusy(false);
      });
  };

  const generate = () => {
    if (!canGenerate || pending.current) return;
    const current = draft.read();
    if (current.text.trim()) return improve();
    if (current.sessionId) suggestNext(current.sessionId, assistFreshnessSeq(host.sessions.events(current.sessionId)));
  };
  const revert = () => {
    const current = draft.read();
    const scope = current.sessionId ?? current.projectId;
    if (!scope || !rewrite || !canRevertPromptRewrite(scope, current.text, rewrite)) return;
    draft.replace(rewrite.original);
    setRewrite(null);
  };

  return (
    <span className="recap-prompt-controls">
      {canRevert && <Tooltip content={tr("settings.widgetspage.undo")}>
        <IconButton icon={UndoIcon} label={tr("settings.widgetspage.undo")} size="sm" onClick={revert} />
      </Tooltip>}
      <Tooltip content={label}>
        <IconButton icon={AssistIcon} label={label} size="sm" busy={busy} disabled={!canGenerate} onClick={generate} />
      </Tooltip>
    </span>
  );
}
