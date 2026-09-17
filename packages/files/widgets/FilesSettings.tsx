import { useEffect, useState } from "react";
import { api } from "@polyth/session/web-api";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, TextInput, Textarea } from "../../../apps/web/src/components/ui/index.ts";
import {
  DEFAULT_EXPLAIN_PROMPT,
  DEFAULT_FIX_PROMPT,
} from "../src/inlineAiShared.ts";

export default function FilesSettings() {
  const [explainPrompt, setExplainPrompt] = useState(DEFAULT_EXPLAIN_PROMPT);
  const [fixPrompt, setFixPrompt] = useState(DEFAULT_FIX_PROMPT);
  const [modelOverride, setModelOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.filesInlineAiSettingsGet()
      .then((settings) => {
        if (cancelled) return;
        setExplainPrompt(settings.explainPrompt);
        setFixPrompt(settings.fixPrompt);
        setModelOverride(settings.modelOverride ?? "");
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(friendlyError(tr("filessettings.loadFailed"), err));
      });
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const next = await api.filesInlineAiSettingsPut({
        explainPrompt,
        fixPrompt,
        modelOverride,
      });
      setExplainPrompt(next.explainPrompt);
      setFixPrompt(next.fixPrompt);
      setModelOverride(next.modelOverride ?? "");
      setSaved(true);
    } catch (err: unknown) {
      setError(friendlyError(tr("filessettings.saveFailed"), err));
    } finally {
      setBusy(false);
    }
  };

  const resetDefaults = () => {
    setExplainPrompt(DEFAULT_EXPLAIN_PROMPT);
    setFixPrompt(DEFAULT_FIX_PROMPT);
    setModelOverride("");
  };

  return (
    <section className="files-settings-page editor-view">
      <p className="muted">{tr("filessettings.placeholderHint")}</p>
      <label className="files-settings-field" data-settings-item="files.inline-ai.explain">
        <span>{tr("filessettings.explainPrompt")}</span>
        <Textarea
          rows={5}
          value={explainPrompt}
          onChange={(event) => setExplainPrompt(event.target.value)}
        />
      </label>
      <label className="files-settings-field" data-settings-item="files.inline-ai.fix">
        <span>{tr("filessettings.fixPrompt")}</span>
        <Textarea
          rows={5}
          value={fixPrompt}
          onChange={(event) => setFixPrompt(event.target.value)}
        />
      </label>
      <label className="files-settings-field" data-settings-item="files.inline-ai.model">
        <span>{tr("filessettings.modelOverride")}</span>
        <TextInput
          value={modelOverride}
          placeholder={tr("filessettings.modelOverridePlaceholder")}
          onChange={(e) => setModelOverride(e.target.value)}
        />
        <span className="muted">{tr("filessettings.modelOverrideHint")}</span>
      </label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {saved ? <p className="muted">{tr("common.saved")}</p> : null}
      <div className="files-settings-actions">
        <Button size="sm" disabled={busy} onClick={() => void save()}>{tr("common.save")}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={resetDefaults}>
          {tr("filessettings.resetDefaults")}
        </Button>
      </div>
    </section>
  );
}
