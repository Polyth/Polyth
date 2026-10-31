// The live agent status dock above the composer while a turn runs: model,
// current action, elapsed time and the run-details popover. The git package
// renders it with its edited-files summary; the chat surface renders it on
// its own when no git dock is placed in `session.footer` (for example a
// project whose composition excludes git), so a running turn never loses it.
// The action's words come from liveAction.ts, shared with the subagent branch.
import { useEffect, useState } from "react";
import { resolveModelPresentation } from "@polyth/contracts/model-presentation";
import { useHarnessColors } from "@polyth/models/runtime-catalog";
import ProviderLogo from "../../../../packages/models/widgets/ProviderLogo.tsx";
import { fmtDuration } from "../format.ts";
import { tr } from "../i18n/index.ts";
import { liveActionOf } from "../liveAction.ts";
import type { resolveSessionActivity } from "../sessionActivity.ts";
import { toggleSessionStatusPopover } from "../sessionStatusPopover.ts";
import type { RenderModel } from "../reduce.ts";
import { useSpaces } from "../spaces.ts";
import { useStore } from "../store.ts";
import { SubagentBranchIsland } from "./SubagentActivityDock.tsx";
import { AgentStatusDock } from "./ui/index.ts";

export interface AgentLiveStatusDockProps {
  activity: ReturnType<typeof resolveSessionActivity>;
  model: RenderModel;
  /** Edited-files summary (git package only). */
  files?: string | null;
  additions?: number;
  deletions?: number;
  diffLabel?: string;
}

export default function AgentLiveStatusDock({ activity, model, files, additions, deletions, diffLabel }: AgentLiveStatusDockProps) {
  const models = useStore((state) => state.models);
  const projectId = useStore((state) => state.activeProjectId);
  const harnessColors = useHarnessColors(projectId ?? undefined, useSpaces().activeSpaceId ?? "");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [model.turn?.startedAt]);

  const replacingTurn = activity.pendingSend?.delivery === "interrupt";
  const modelRef = activity.model;
  const runtimeHarnessId = activity.harnessId;
  // ACP runtimes such as Cursor can omit the model from `turn/started` when
  // native Auto is active. Otherwise use the same harness-aware, human
  // presentation as completed response footers.
  const presentation = modelRef
    ? resolveModelPresentation(modelRef, models, runtimeHarnessId)
    : { descriptor: undefined, name: tr("composer.auto") };
  const descriptor = presentation.descriptor;
  // The profile that runs the turn tints the logo, as its harness tab does.
  const tint = harnessColors.get(runtimeHarnessId ?? descriptor?.harnessId ?? "");
  const action = replacingTurn
    ? tr("workspace.builtinsurfaces.startingTurn")
    : liveActionOf(model);
  const elapsed = replacingTurn || model.turn?.startedAt === undefined
    ? null
    : fmtDuration(now - model.turn.startedAt);
  // In the composer's status zone the chat's active subagents hang from this
  // line (SubagentBranchIsland); placed anywhere else it stays one line.
  return (
    <SubagentBranchIsland>
      <AgentStatusDock
        icon={<ProviderLogo
          providerID={descriptor?.providerID ?? modelRef?.providerID}
          providerName={descriptor?.providerName}
          harnessId={descriptor?.harnessId ?? runtimeHarnessId}
          size="regular"
          tint={tint}
        />}
        model={presentation.name}
        status={action}
        elapsed={elapsed}
        {...(files !== undefined ? { files } : {})}
        {...(additions !== undefined ? { additions } : {})}
        {...(deletions !== undefined ? { deletions } : {})}
        {...(diffLabel !== undefined ? { diffLabel } : {})}
        label={tr("pendingchangesbar.openActiveRunDetailsValue", { action })}
        onClick={(event) => toggleSessionStatusPopover(event.currentTarget, "dock")}
      />
    </SubagentBranchIsland>
  );
}
