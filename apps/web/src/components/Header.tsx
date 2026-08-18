import { useMemo, useState } from "react";
import { useActiveModel, useStore } from "../store.ts";
import { forkSession, exportSessionMarkdown } from "../init.ts";
import { GoalAttachForm } from "./GoalStrip.tsx";
import type { RenderModel } from "../reduce.ts";
import type { SessionProjection, ModelDescriptor } from "@polyth/contracts";

function contextUsage(
  model: RenderModel,
  session: SessionProjection | null,
  models: ModelDescriptor[],
): { pct: number; level: "green" | "yellow" | "red" } | null {
  const total = model.totals.input + model.totals.output;
  if (total <= 0 || !session?.model) return null;
  const desc = models.find(
    (m) => m.providerID === session.model!.providerID && m.modelID === session.model!.modelID,
  );
  if (!desc?.context) return null;
  const pct = Math.round((total / desc.context) * 100);
  return { pct, level: pct < 60 ? "green" : pct < 85 ? "yellow" : "red" };
}

export default function Header() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const models = useStore((s) => s.models);
  const model = useActiveModel();
  const ctx = useMemo(() => contextUsage(model, session, models), [model, session, models]);
  const [goalFormOpen, setGoalFormOpen] = useState(false);

  return (
    <>
      <header className="header">
        <div className="header-session">
          <span className="header-kicker">Session</span>
          <div className="header-title">{session?.title ?? "(untitled session)"}</div>
        </div>
        {ctx && <span className={`ctx-badge ${ctx.level}`}>{ctx.pct}% context</span>}
        <span className="header-spacer" />
        <button className="header-action" onClick={() => setGoalFormOpen((v) => !v)}>Goal</button>
        <button className="header-action" onClick={() => void forkSession(session!.id).catch((e) => window.alert(`fork failed: ${e}`))}>
          Fork
        </button>
        <button className="header-action" onClick={exportSessionMarkdown}>Export</button>
      </header>
      {goalFormOpen && <GoalAttachForm onDone={() => setGoalFormOpen(false)} />}
    </>
  );
}
