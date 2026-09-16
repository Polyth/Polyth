import { useEffect, useState } from "react";
import { api } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";
import { getBrowserVisibility, setBrowserVisibility, subscribeBrowserVisibility, type BrowserVisibilityMode } from "./browserVisibility.ts";

export default function BrowserSettingsPage({ host }: { host: WebPackageHost }) {
  const { Select, Checkbox } = host.ui.components;
  const translate = host.ui.locale.translate;
  const [mode, setMode] = useState<BrowserVisibilityMode>(getBrowserVisibility);
  const [autoApprove, setAutoApprove] = useState(true);
  const [autoApproveBusy, setAutoApproveBusy] = useState(false);
  const [autoApproveError, setAutoApproveError] = useState<string | null>(null);

  useEffect(() => subscribeBrowserVisibility(() => setMode(getBrowserVisibility())), []);

  useEffect(() => {
    let cancelled = false;
    void api.browserAgentAutoApproveGet()
      .then((result) => {
        if (!cancelled) setAutoApprove(result.enabled);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAutoApproveError(host.errors.friendly(translate("browser.settings.agentAutoApprove"), error));
        }
      });
    return () => { cancelled = true; };
  }, [host.errors, translate]);

  return (
    <section className="browser-settings-page">
      <div className="browser-settings-row" data-settings-item="browser.agent-auto-approve">
        <div>
          <strong>{translate("browser.settings.agentAutoApprove")}</strong>
          <p>{translate("browser.settings.agentAutoApproveDescription")}</p>
          {autoApproveError ? <p role="alert">{autoApproveError}</p> : null}
        </div>
        <Checkbox
          checked={autoApprove}
          disabled={autoApproveBusy}
          label={translate("browser.settings.agentAutoApprove")}
          onChange={(checked: boolean) => {
            const previous = autoApprove;
            setAutoApprove(checked);
            setAutoApproveBusy(true);
            setAutoApproveError(null);
            void api.browserAgentAutoApproveSet(checked)
              .then((result) => setAutoApprove(result.enabled))
              .catch((error: unknown) => {
                setAutoApprove(previous);
                setAutoApproveError(host.errors.friendly(translate("browser.settings.agentAutoApprove"), error));
              })
              .finally(() => setAutoApproveBusy(false));
          }}
        />
      </div>
      <div className="browser-settings-row" data-settings-item="browser.visibility">
        <div>
          <strong>{translate("previewview.browserVisibility")}</strong>
          <p>{translate("previewview.browserVisibilityDescription")}</p>
        </div>
        <Select
          ariaLabel={translate("previewview.browserVisibility")}
          value={mode}
          options={[
            { value: "background", label: translate("previewview.background") },
            { value: "auto-show", label: translate("previewview.autoShow") },
          ]}
          onChange={(value: unknown) => {
            const next = String(value) === "auto-show" ? "auto-show" : "background";
            setBrowserVisibility(next);
          }}
        />
      </div>
    </section>
  );
}

export type { BrowserVisibilityMode };
