import { useEffect, useId, useState } from "react";
import { useCoach } from "./store.ts";
import CoachView from "./CoachView.tsx";
import CoachSetup from "./CoachSetup.tsx";
import { GoalsPanel, PlansPanel, QuickCommitment, type CoachUiProps } from "./CoachDetails.tsx";

export default function CoachWorkspace(props: CoachUiProps & { openSettings(): void }) {
  const { client, ui, openSettings } = props;
  const { Button, Tabs } = ui;
  const snapshot = useCoach(client);
  const [tab, setTab] = useState("today");
  const id = useId();
  useEffect(() => { void client.refresh(); }, [client]);
  return <div className="personal-coach-root coach-workspace" aria-busy={!snapshot.home && snapshot.status === "loading"}>
    {snapshot.error && <div className="coach-inline-error" role="alert"><p>{snapshot.error}</p><Button size="sm" variant="ghost" onClick={() => void client.refresh()}>Refresh Coach</Button></div>}
    {!snapshot.home ? (!snapshot.error && <p role="status" className="coach-loading">Loading Coach…</p>) : snapshot.home.profile.onboardingState !== "complete" ? <CoachSetup {...props} /> : <>
      <div className="coach-toolbar"><Tabs tabs={[{ id: "today", label: "Today" }, { id: "goals", label: "Goals" }, { id: "plan", label: "Plan" }]} value={tab} onChange={setTab} label="Coach views" idBase={id} size="sm" /><Button size="sm" variant="ghost" onClick={openSettings}>Settings</Button></div>
      <div role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`} tabIndex={0}>
        {tab === "today" && <><CoachView client={client} /><QuickCommitment {...props} /></>}
        {tab === "goals" && <GoalsPanel {...props} />}
        {tab === "plan" && <PlansPanel {...props} />}
      </div>
      <div className="coach-bottom-actions"><Button variant="primary" busy={snapshot.busy.has("talk")} onClick={() => void client.talk()}>{snapshot.talkStage === "opening" ? "Opening conversation…" : "Talk to Coach"}</Button><Button size="sm" variant="ghost" onClick={() => void client.refresh()}>Refresh</Button><span className="coach-meta">Saved in this Space</span></div>
    </>}
  </div>;
}
