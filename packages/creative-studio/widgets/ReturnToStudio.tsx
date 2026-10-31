import { useSyncExternalStore } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { CREATIVE_STUDIO_PACKAGE_ID, CREATIVE_STUDIO_PURPOSE } from "../src/index.ts";
import { ChevronGlyph, ClapperGlyph } from "./glyphs.tsx";
import { studioStrings } from "./strings.ts";
import { agentState } from "./studioModel.ts";

/** Above the composer of a studio chat that the studio no longer covers (the
 * person opened the conversation): one tap back into the studio. */
export default function ReturnToStudio({ host, sessionId }: { host: WebPackageHost; sessionId: string | null }) {
  const shell = useSyncExternalStore(host.store.subscribe, () => {
    const snapshot = host.store.getSnapshot();
    return snapshot.workbenchProfile === CREATIVE_STUDIO_PACKAGE_ID && snapshot.railPlugin !== CREATIVE_STUDIO_PACKAGE_ID;
  }, () => false);
  const session = useSyncExternalStore(host.sessions.subscribe, () => {
    const current = sessionId ? host.sessions.get(sessionId) : undefined;
    return current ? `${current.purpose ?? ""}|${agentState(current)}` : "";
  }, () => "");
  const [purpose, agent] = session.split("|");
  if (!shell || (sessionId && purpose !== CREATIVE_STUDIO_PURPOSE)) return null;
  const t = studioStrings(host.ui.locale.get());
  return (
    <div className="creative-studio-return">
      <button type="button" className="cs-return-button ui-glass-island" onClick={() => host.workbench.activateProfile(CREATIVE_STUDIO_PACKAGE_ID)}>
        <span className="cs-return-mark" aria-hidden="true"><ClapperGlyph /></span>
        {t.backToStudio}
        <ChevronGlyph />
      </button>
      {agent !== "needs-you" && <span className="cs-return-hint">{t.backToStudioHint}</span>}
    </div>
  );
}
