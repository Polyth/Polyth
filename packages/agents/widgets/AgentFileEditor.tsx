import { useEffect, useId, useMemo, useRef, useState } from "react";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { Notice, Textarea } from "../../../apps/web/src/components/ui/index.ts";
import { parseAgentFile, serializeAgentFile } from "../src/agentFile.ts";
import { draftToSpec, specToDraft, type AgentDraftState } from "./agentModel.ts";

/** The agent as its agent/v1 file. Typing a valid file updates the form;
 *  changing the form rewrites the file. An invalid file reports why and
 *  blocks saving through `onError`. */
export default function AgentFileEditor({
  draft,
  fileId,
  readOnly,
  onChange,
  onError,
}: {
  draft: AgentDraftState;
  fileId: string;
  readOnly?: boolean;
  onChange: (next: AgentDraftState) => void;
  onError: (error: string) => void;
}) {
  const errorId = useId();
  const generated = useMemo(() => {
    const result = draftToSpec(draft, fileId);
    return "spec" in result ? { text: serializeAgentFile(result.spec) } : { unsupported: result.error };
  }, [draft, fileId]);
  const [text, setText] = useState(generated.text ?? "");
  const [error, setError] = useState("");
  const typing = useRef(false);

  // The form changed (or the draft was reset): show its file again.
  useEffect(() => {
    if (!typing.current && generated.text !== undefined) {
      setText(generated.text);
      setError("");
    }
  }, [generated.text]);
  useEffect(() => { onError(error); }, [error, onError]);
  useEffect(() => () => onError(""), [onError]);

  if (generated.unsupported) return <Notice tone="info">{generated.unsupported}</Notice>;
  const hasWebhooks = draft.eventTriggers.some((trigger) => trigger.kind === "webhook");

  return (
    <div className="agent-file">
      <p className="agent-field-hint">
        {readOnly ? tr("agents.fileReadOnly") : tr("agents.fileHint")}
        {hasWebhooks ? ` ${tr("agents.fileWebhooksKept")}` : ""}
      </p>
      <Textarea
        className="agent-file-text"
        aria-label={tr("agents.editAsFile")}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        spellCheck={false}
        autoGrow
        minRows={14}
        maxRows={40}
        value={text}
        readOnly={readOnly}
        onFocus={() => { typing.current = true; }}
        onBlur={() => {
          typing.current = false;
          if (!error && generated.text !== undefined) setText(generated.text);
        }}
        onChange={(event) => {
          const value = event.target.value;
          setText(value);
          const parsed = parseAgentFile(value);
          if (!parsed.spec) {
            setError(parsed.error);
            return;
          }
          setError("");
          onChange(specToDraft(parsed.spec, draft, getLocale()));
        }}
      />
      {error && <p id={errorId} className="agent-file-error" role="alert">{tr("agents.fileErrorValue", { error })}</p>}
    </div>
  );
}
