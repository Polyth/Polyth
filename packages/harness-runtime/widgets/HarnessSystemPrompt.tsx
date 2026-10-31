import { useEffect, useState } from "react";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { Textarea } from "../../../apps/web/src/components/ui/index.ts";
import { ErrorState, SaveBar, Section } from "../../../apps/web/src/components/settings/parts.tsx";

const api = createApiTransport();
const MAX_SYSTEM_PROMPT = 64 * 1024;

type PromptResponse = { systemPrompt: string };

export default function HarnessSystemPrompt({ host, harnessId }: { host: WebPackageHost; harnessId: string }) {
  const t = (key: string, values?: Record<string, string | number>) => host.ui.locale.translate(`harnessruntime.systemPrompt.${key}`, values);
  const [saved, setSaved] = useState("");
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    setStatus("idle");
    void api.get<PromptResponse>(`/api/harnesses/${encodeURIComponent(harnessId)}/system-prompt`)
      .then((response) => {
        if (!active) return;
        const prompt = typeof response.systemPrompt === "string" ? response.systemPrompt : "";
        setSaved(prompt);
        setValue(prompt);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setLoadError(cause instanceof Error ? cause.message : t("loadFailed"));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [harnessId, loadVersion]);

  const save = async () => {
    setBusy(true);
    setError("");
    setStatus("idle");
    try {
      const response = await api.put<PromptResponse>(
        `/api/harnesses/${encodeURIComponent(harnessId)}/system-prompt`,
        { systemPrompt: value },
      );
      const prompt = typeof response.systemPrompt === "string" ? response.systemPrompt : value;
      setSaved(prompt);
      setValue(prompt);
      setStatus("saved");
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pkg-harnesses pkg-harnesses-panel">
      <Section itemId={`harness.${harnessId}.systemPrompt`} title={t("title")}
        hint={t("hint")}>
        {loadError ? <ErrorState compact title={t("loadTitle")} error={loadError} onRetry={() => setLoadVersion((value) => value + 1)} /> : <>
          <Textarea
            aria-label={t("title")}
            value={value}
            onChange={(event) => { setValue(event.currentTarget.value); setStatus("idle"); }}
            placeholder={t("placeholder")}
            minRows={8}
            maxRows={18}
            autoGrow
            maxLength={MAX_SYSTEM_PROMPT}
            disabled={loading || busy}
            spellCheck
          />
          <small className="pkg-harnesses-panel-count">{value.length.toLocaleString()} / {MAX_SYSTEM_PROMPT.toLocaleString()}</small>
          <SaveBar dirty={!loading && value !== saved} saving={busy} status={status} {...(error ? { error } : {})}
            onDiscard={() => { setValue(saved); setStatus("idle"); }} onSave={() => void save()} />
        </>}
      </Section>
    </div>
  );
}
