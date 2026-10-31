import { useEffect, useState } from "react";
import { createApiTransport, isImeComposing, type WebPackageHost } from "@polyth/web-sdk";
import { Select, Switch } from "../../../apps/web/src/components/ui/index.ts";
import { rememberAssistSettings, type AssistSettings as RecapSettings, type SuggestionPriority } from "./assistSettings.ts";

const api = createApiTransport();

export default function RecapSettings({ host }: { host: WebPackageHost }) {
  const [settings, setSettings] = useState<RecapSettings | null>(null);
  const [value, setValue] = useState("120");
  const tr = host.ui.locale.translate;
  const TextInput = host.ui.components.TextInput;

  useEffect(() => {
    let live = true;
    void api.get<RecapSettings>("/api/settings/assist")
      .then((next) => {
        if (!live) return;
        rememberAssistSettings(next);
        setSettings(next);
        setValue(String(next.idleSeconds));
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const save = () => {
    if (!settings) return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      setValue(String(settings.idleSeconds));
      return;
    }
    void api.put<RecapSettings>("/api/settings/assist", { idleSeconds: parsed })
      .then((next) => {
        rememberAssistSettings(next);
        setSettings(next);
        setValue(String(next.idleSeconds));
      })
      .catch(() => setValue(String(settings.idleSeconds)));
  };

  const patch = (change: Partial<Pick<RecapSettings, "suggestNextPrompt" | "suggestionPriority" | "showCallouts">>) => {
    if (!settings) return;
    setSettings({ ...settings, ...change });
    void api.put<RecapSettings>("/api/settings/assist", change)
      .then((next) => {
        rememberAssistSettings(next);
        setSettings(next);
      })
      .catch(() => setSettings(settings));
  };
  const priority: SuggestionPriority = settings?.suggestionPriority === "assist" ? "assist" : "harness";
  const priorityOptions = [
    { value: "harness", label: tr("settings.pages.suggestionPriorityHarness") },
    { value: "assist", label: tr("settings.pages.suggestionPriorityAssist") },
  ];

  return (
    <section className="recap-settings">
      <header className="recap-settings-head">
        <h2>{tr("settings.pages.callouts")}</h2>
        <p>{tr("settings.pages.calloutsHint")}</p>
      </header>
      <div className="recap-setting-row">
        <div>
          <strong id="recap-show-callouts">{tr("callouts.title")}</strong>
          <span className="recap-setting-hint">{tr("settings.pages.showCalloutsHint")}</span>
        </div>
        <Switch
          checked={settings?.showCallouts === true}
          disabled={!settings}
          labelledBy="recap-show-callouts"
          onChange={(showCallouts: boolean) => patch({ showCallouts })}
        />
      </div>
      <header className="recap-settings-head">
        <h2>{tr("settings.pages.nextPrompt")}</h2>
      </header>
      <div className="recap-setting-row">
        <div>
          <strong id="recap-suggest-next-prompt">{tr("settings.pages.suggestNextPrompt")}</strong>
          <span className="recap-setting-hint">{tr("settings.pages.suggestNextPromptHint")}</span>
        </div>
        <Switch
          checked={settings?.suggestNextPrompt !== false}
          disabled={!settings}
          labelledBy="recap-suggest-next-prompt"
          onChange={(suggestNextPrompt: boolean) => patch({ suggestNextPrompt })}
        />
      </div>
      <div className="recap-setting-row recap-setting-row-control">
        <div>
          <strong>{tr("settings.pages.suggestionPriority")}</strong>
          <span className="recap-setting-hint">{tr("settings.pages.suggestionPriorityHint")}</span>
        </div>
        <div className="recap-setting-control recap-setting-choice">
          <Select
            ariaLabel={tr("settings.pages.suggestionPriority")}
            label={priorityOptions.find((option) => option.value === priority)!.label}
            value={priority}
            options={priorityOptions}
            disabled={!settings}
            onChange={(value: string) => patch({ suggestionPriority: value === "assist" ? "assist" : "harness" })}
          />
        </div>
      </div>
      <header className="recap-settings-head">
        <h2>{tr("assiststrip.recap")}</h2>
        <p>{tr("settings.pages.afterASessionGoesQuietTheSmall")}</p>
      </header>
      <div className="recap-setting-row recap-setting-row-control">
        <div>
          <strong>{tr("settings.pages.quietTime")}</strong>
          <span className="recap-setting-hint">{tr("settings.pages.secondsOfInactivityAfterAReplyBefore")}</span>
        </div>
        <div className="recap-setting-control">
          <TextInput
            type="number"
            value={value}
            aria-label={tr("settings.pages.assistQuietTimeInSeconds")}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return;
              if (event.key === "Enter") save();
            }}
            onBlur={save}
          />
          <span>{tr("settings.pages.s")}</span>
        </div>
      </div>
    </section>
  );
}
