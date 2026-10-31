import { useEffect, useId, useState } from "react";
import CoachSetup from "./CoachSetup.tsx";
import GoalsPanel from "./GoalsPanel.tsx";
import Overview from "./Overview.tsx";
import ReviewPanel from "./ReviewPanel.tsx";
import TodayPanel from "./TodayPanel.tsx";
import { CoachError, type CoachUiProps } from "./parts.tsx";
import { useCoach } from "./store.ts";
import { t } from "./strings.ts";

type CoachTab = "overview" | "today" | "goals" | "review";

/**
 * One semantic Coach surface. Composition adapts by container width (see
 * workspace.css), not by three separate implementations — the same markup
 * serves a 320px phone, a 620px docked pane and a wide desktop workspace.
 */
export default function CoachWorkspace(props: CoachUiProps & { openSettings(): void }) {
  const { client, ui, openSettings } = props;
  const { Button, Tabs } = ui;
  const snapshot = useCoach(client);
  const [tab, setTab] = useState<CoachTab>("overview");
  const [goalId, setGoalId] = useState<string | null>(null);
  const id = useId();
  useEffect(() => { void client.refresh(); }, [client]);

  const home = snapshot.home;
  // Review is navigable at all times but only advertises itself when it has
  // something. An empty permanent product area is what this replaces.
  const reviewCount = (home?.suggestionCount ?? 0) + (home?.reviewDue ? 1 : 0);
  const tabs = [
    { id: "overview", label: t("coach.tab.overview") },
    { id: "today", label: t("coach.tab.today") },
    { id: "goals", label: t("coach.tab.goals") },
    { id: "review", label: reviewCount > 0 ? `${t("coach.tab.review")} · ${reviewCount}` : t("coach.tab.review") },
  ];

  const openGoal = (value: string) => { setGoalId(value); setTab("goals"); };

  return <div className="personal-coach-root coach-workspace" aria-busy={!home && snapshot.status === "loading"}>
    {snapshot.error && <CoachError message={snapshot.error} ui={ui} onRetry={() => void client.refresh()} />}
    {!home
      ? (!snapshot.error && <p role="status" className="coach-loading">{t("coach.workspace.loading")}</p>)
      : home.profile.onboardingState !== "complete"
        ? <CoachSetup {...props} />
        : <>
            <div className="coach-toolbar">
              <Tabs
                tabs={tabs}
                value={tab}
                onChange={(next: string) => { setTab(next as CoachTab); if (next !== "goals") setGoalId(null); }}
                label={t("coach.workspace.views")}
                idBase={id}
                size="sm"
              />
              <div className="coach-toolbar-actions">
                <Button
                  variant="primary"
                  size="sm"
                  busy={snapshot.busy.has("talk")}
                  onClick={() => void client.talk()}
                >{snapshot.talkStage === "opening" ? t("coach.ask.opening") : t("coach.ask.label")}</Button>
                <Button size="sm" variant="ghost" onClick={openSettings}>{t("coach.workspace.settings")}</Button>
              </div>
            </div>
            <div
              className="coach-body"
              role="tabpanel"
              id={`${id}-panel-${tab}`}
              aria-labelledby={`${id}-tab-${tab}`}
              tabIndex={0}
            >
              {tab === "overview" && <Overview {...props} onOpenGoal={openGoal} onOpenReview={() => setTab("review")} />}
              {tab === "today" && <TodayPanel {...props} />}
              {tab === "goals" && <GoalsPanel {...props} selectedGoalId={goalId} onSelectGoal={setGoalId} />}
              {tab === "review" && <ReviewPanel {...props} />}
            </div>
          </>}
  </div>;
}
