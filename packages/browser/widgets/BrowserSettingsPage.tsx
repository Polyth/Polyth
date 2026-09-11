import { useEffect, useState } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { getBrowserVisibility, setBrowserVisibility, subscribeBrowserVisibility, type BrowserVisibilityMode } from "./browserVisibility.ts";

export default function BrowserSettingsPage({ host }: { host: WebPackageHost }) {
  const Select = host.ui.components.Select;
  const [mode, setMode] = useState<BrowserVisibilityMode>(getBrowserVisibility);
  useEffect(() => subscribeBrowserVisibility(() => setMode(getBrowserVisibility())), []);
  return (
    <section className="browser-settings-page">
      <div className="browser-settings-row">
        <div>
          <strong>{host.ui.locale.translate("previewview.browserVisibility")}</strong>
          <p>{host.ui.locale.translate("previewview.browserVisibilityDescription")}</p>
        </div>
        <Select
          ariaLabel={host.ui.locale.translate("previewview.browserVisibility")}
          value={mode}
          options={[
            { value: "background", label: host.ui.locale.translate("previewview.background") },
            { value: "auto-show", label: host.ui.locale.translate("previewview.autoShow") },
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
