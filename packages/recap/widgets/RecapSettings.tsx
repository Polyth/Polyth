import { useEffect, useState } from "react";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";

interface AssistSettings {
  enabled: boolean;
  idleSeconds: number;
}

const api = createApiTransport();

export default function RecapSettings({ host }: { host: WebPackageHost }) {
  const [settings, setSettings] = useState<AssistSettings | null>(null);
  const [value, setValue] = useState("120");
  const tr = host.ui.locale.translate;
  const TextInput = host.ui.components.TextInput;

  useEffect(() => {
    let live = true;
    void api.get<AssistSettings>("/api/settings/assist")
      .then((next) => {
        if (!live) return;
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
    void api.put<AssistSettings>("/api/settings/assist", { idleSeconds: parsed })
      .then((next) => {
        setSettings(next);
        setValue(String(next.idleSeconds));
      })
      .catch(() => setValue(String(settings.idleSeconds)));
  };

  return (
    <section className="recap-settings">
      <header className="recap-settings-head">
        <h2>{tr("assiststrip.recap")}</h2>
        <p>{tr("settings.pages.afterASessionGoesQuietTheSmall")}</p>
      </header>
      <div className="recap-setting-row">
        <div>
          <strong>{tr("settings.pages.quietTime")}</strong>
          <span>{tr("settings.pages.secondsOfInactivityAfterAReplyBefore")}</span>
        </div>
        <div className="recap-setting-control">
          <TextInput
            type="number"
            value={value}
            aria-label={tr("settings.pages.assistQuietTimeInSeconds")}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") save();
            }}
          />
          <span>{tr("settings.pages.s")}</span>
        </div>
      </div>
    </section>
  );
}
