import "./styles.css";
import { useSyncExternalStore } from "react";
import type { SessionEvent } from "@polyth/contracts";
import { defineWebPackage } from "@polyth/web-sdk";
import { ASSESSMENT_EVENT } from "../src/types.ts";
import AssessmentMarker from "./AssessmentMarker.tsx";
import JudgesSettings from "./JudgesSettings.tsx";
import RequestVerdicts from "./RequestVerdict.tsx";
import { judgesTour } from "./onboardingTour.ts";

export default defineWebPackage((host) => () => {
  const translate = (key: string, values?: Record<string, string | number>) => host.ui.locale.translate(key, values);
  function SettingsPage() {
    const projectId = useSyncExternalStore(host.store.subscribe, () => host.store.getSnapshot().activeProjectId);
    return <JudgesSettings key={projectId} projectId={projectId} openJudgment={() => host.navigation.openSettingsPage("judgment")} />;
  }
  const off = [
    host.settings.registerPage({ id: "judges", packageId: "judgment-judges", label: translate("judgesui.pageLabel"), group: "Engineering", order: 56, icon: "circle-check", component: SettingsPage }),
    host.settings.registerItems([
      { id: "judges.list", pageId: "judges", label: translate("judgesui.itemJudges"), description: translate("judgesui.itemJudgesDescription"),
        keywords: ["judges", "judgment", "rules", "checks", "backtest", "starter", "templates", "permissions", "approve", "continue"], focusTarget: "judges.list" },
      { id: "judges.builtins", pageId: "judges", label: translate("judgesui.builtinsTitle"), description: translate("judgesui.builtinsHint"),
        keywords: ["completion check", "waiting for you", "keep warm", "quiet commands", "keep running"], focusTarget: "judges.builtins" },
    ]),
    // The header's "?" on Settings → Judges: what judges are, starters, whose access, trying before trusting.
    host.onboarding ? host.onboarding.registerTour(judgesTour(translate)) : () => {},
    // The fill-only action inserts into the composer; the person decides whether to send.
    host.slots.register({ id: "judges.assessment-marker", slot: "session.timeline.event", order: 40, meta: { eventTypes: [ASSESSMENT_EVENT] },
      render: (props) => <AssessmentMarker event={props.event as SessionEvent} insert={(text) => host.conversation.insert(text)} /> }),
    // A permission judge's verdict on the request a card shows, beside its decisions.
    host.slots.register({ id: "judges.request-verdict", slot: "session.permission.notes", order: 40,
      render: ({ sessionId, requestId, sourceSessionId }) => typeof sessionId === "string" && typeof requestId === "string"
        ? <RequestVerdicts sessions={host.sessions} sessionId={sessionId} requestId={requestId}
          {...(typeof sourceSessionId === "string" ? { sourceSessionId } : {})} />
        : null }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
