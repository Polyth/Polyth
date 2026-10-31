import type { WebPackageHost } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { MARKET_SECTION_LINKS, type MarketSurfaceId } from "./navigation.ts";
export { MARKET_SECTION_LINKS, type MarketSurfaceId, type MarketSurfaceLink } from "./navigation.ts";

/** Section switcher for the Markets frame. Scroll ownership, the edge fade,
 *  inline padding, touch containment and the hidden scrollbar come from the
 *  shared .ui-scroll-tabs primitive (apps/web styles.css); local CSS keeps
 *  layout only. */
export function MarketSurfaceNav({
  host,
  activeId,
}: {
  host: WebPackageHost;
  activeId: MarketSurfaceId;
}) {
  return (
    <nav className="markets-surface-nav ui-scroll-tabs" aria-label={tr("markets.nav.sectionsAria")}>
      {MARKET_SECTION_LINKS.map((link) => (
        <host.ui.components.Button
          key={link.id}
          size="sm"
          variant={activeId === link.id ? "quiet" : "ghost"}
          aria-current={activeId === link.id ? "page" : undefined}
          onClick={() => host.navigation.openWorkspacePane(link.id)}
        >
          {tr(link.labelKey)}
        </host.ui.components.Button>
      ))}
    </nav>
  );
}
