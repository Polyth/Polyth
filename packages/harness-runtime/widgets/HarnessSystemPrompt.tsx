import { useEffect, useMemo, useState } from "react";
import { createApiTransport } from "@polyth/web-sdk";
import { Button, Notice, Textarea } from "../../../apps/web/src/components/ui/index.ts";

const api = createApiTransport();
const MAX_SYSTEM_PROMPT = 64 * 1024;

type PromptResponse = { systemPrompt: string };

export default function HarnessSystemPrompt({ harnessId }: { harnessId: string }) {
  const [saved, setSaved] = useState("");
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fieldId = useMemo(() => `harness-system-prompt-${harnessId}`, [harnessId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setNotice("");
    void api.get<PromptResponse>(`/api/harnesses/${encodeURIComponent(harnessId)}/system-prompt`)
      .then((response) => {
        if (!active) return;
        const prompt = typeof response.systemPrompt === "string" ? response.systemPrompt : "";
        setSaved(prompt);
        setValue(prompt);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Could not load the system prompt.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [harnessId]);

  const save = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await api.put<PromptResponse>(
        `/api/harnesses/${encodeURIComponent(harnessId)}/system-prompt`,
        { systemPrompt: value },
      );
      const prompt = typeof response.systemPrompt === "string" ? response.systemPrompt : value;
      setSaved(prompt);
      setValue(prompt);
      setNotice(prompt.trim() ? "System prompt saved." : "System prompt cleared.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the system prompt.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" data-settings-item={`harness.${harnessId}.systemPrompt`}>
      <div className="settings-section-head">
        <div>
          <strong>System prompt</strong>
          <span>Additional instructions used only by this harness, after Polyth&apos;s global behavior.</span>
        </div>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      <label htmlFor={fieldId}>Additional system prompt</label>
      <Textarea
        id={fieldId}
        value={value}
        onChange={(event) => { setValue(event.currentTarget.value); setNotice(""); }}
        placeholder="Add harness-specific instructions…"
        minRows={8}
        maxRows={18}
        autoGrow
        maxLength={MAX_SYSTEM_PROMPT}
        disabled={loading || busy}
        spellCheck
      />
      <div className="settings-actions">
        <span>{value.length.toLocaleString()} / {MAX_SYSTEM_PROMPT.toLocaleString()}</span>
        <Button onClick={() => void save()} disabled={loading || busy || value === saved}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </section>
  );
}
