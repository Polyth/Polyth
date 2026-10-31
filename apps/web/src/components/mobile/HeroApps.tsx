// The new chat's Apps widget: package windows the user pinned onto the screen
// as a calm row of icon tiles. Which packages and in what order is chosen in
// the screen's Customize panel (HeroCustomize.tsx); a tile opens the same
// window its rail launcher does. Packages come from the capability registry
// (useWindowPackages), so an unloaded package simply drops out until it
// returns and its place in the order is kept.
import type { ReactNode } from "react";
import { tr } from "../../i18n/index.ts";
import { railIconFor } from "../../railIcons.ts";
import { openPackageWindow, useWindowPackages } from "../../starterPackages.ts";
import { useShellMode } from "../../responsiveShell.ts";
import { tapFeedback } from "../../haptics.ts";
import { dismissKeyboard } from "../../mobileViewport.ts";
import type { StarterPackage } from "../../starters.ts";
import { HeroWidget, useHeroWidgetPrefs } from "./HeroWidgets.tsx";

/** Pure: pinned ids resolved against the loaded packages, in pinned order. */
export function pinnedHeroApps(ids: readonly string[], packages: readonly StarterPackage[]): StarterPackage[] {
  const byId = new Map(packages.map((entry) => [entry.id, entry]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** The app's glyph on its tile — shared by the screen and the panel. */
export function HeroAppGlyph({ id }: { id: string }) {
  const Glyph = railIconFor(id);
  return <span className="hero-app-tile" aria-hidden="true"><Glyph /></span>;
}

export function HeroAppTileContent({ app, label = true, badge }: { app: StarterPackage; label?: boolean; badge?: ReactNode }) {
  return (
    <>
      <HeroAppGlyph id={app.id} />
      {badge}
      {label && <span className="hero-app-label">{app.label}</span>}
    </>
  );
}

export function HeroAppsWidget() {
  const prefs = useHeroWidgetPrefs().apps;
  const packages = useWindowPackages();
  const phone = useShellMode() === "phone";
  const apps = pinnedHeroApps(prefs.ids, packages);
  if (apps.length === 0) return null;
  return (
    <HeroWidget id="apps">
      <ul className="hero-apps" aria-label={tr("workspace.heroapps.title")} data-labels={prefs.labels ? "true" : "false"}>
        {apps.map((app) => (
          <li key={app.id}>
            <button
              type="button"
              className="hero-app"
              title={app.description ?? app.label}
              aria-label={tr("mobile.starterpicker.openValue", { label: app.label })}
              onClick={() => {
                if (phone) tapFeedback();
                void dismissKeyboard();
                openPackageWindow(app.id);
              }}
            >
              <HeroAppTileContent app={app} label={prefs.labels} />
            </button>
          </li>
        ))}
      </ul>
    </HeroWidget>
  );
}
