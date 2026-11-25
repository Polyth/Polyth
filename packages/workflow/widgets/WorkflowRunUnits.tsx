import { useState, type ReactNode } from "react";
import type { HarnessSelection, ModelDescriptor, ModelRef, WorkflowNodeDto, WorkflowRunDto, WorkflowRunStatus } from "@polyth/contracts";
import { modelSupportsTextWorkflow } from "../../../apps/web/src/composer/discovery.ts";
import { useRuntimeCatalog } from "@polyth/models/runtime-catalog";
import { useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Checkbox } from "../../../apps/web/src/components/ui/index.ts";
import { WorkflowRoutePicker, harnessValue, sameModel } from "./WorkflowView.tsx";
import { workflowNeedsFix } from "./workflowRun.ts";

export type RetryFn = (
  nodeId: string,
  replacement?: Pick<WorkflowNodeDto, "model" | "harness" | "agent">,
  saveToWorkflow?: boolean
) => void;

/** Another route for a failed unit: while the run holds the unit it
 * continues in place, after the run settled it forks. Either way the new
 * route can be kept on the template for every later run. */
export function RetryControls({
  node, runStatus, busy, models, harnessSlot, projectId, spaceId, onRetry, primary = true,
}: {
  /** False when the person steps in on a unit the chat's agent is fixing. */
  primary?: boolean;
  node: WorkflowRunDto["nodes"][number];
  runStatus: WorkflowRunStatus;
  busy: boolean;
  models: ModelDescriptor[];
  harnessSlot?: (context: Record<string, unknown>) => ReactNode;
  projectId: string;
  spaceId: string;
  onRetry: RetryFn;
}) {
  const agents = useStore((state) => state.agents);
  const [replacementModel, setReplacementModel] = useState<ModelRef>();
  const [replacementHarness, setReplacementHarness] = useState<HarnessSelection>();
  const [saveToWorkflow, setSaveToWorkflow] = useState(true);
  const held = workflowNeedsFix(node);
  const targetHarness = replacementHarness ?? node.harness;
  const harnessId = targetHarness?.mode === "pinned" ? targetHarness.harnessId : undefined;
  const catalog = useRuntimeCatalog(null, models, agents, {
    ...(projectId ? { projectId } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(harnessId ? { harnessId } : {}),
  });
  const available = catalog.models.filter(modelSupportsTextWorkflow);
  const harnessChanged = !!replacementHarness && harnessValue(replacementHarness) !== harnessValue(node.harness);
  const needsModel = harnessChanged && !!node.model &&
    !available.some((model) => sameModel(model, node.model));
  const modelChanged = !!replacementModel
    && (!sameModel(replacementModel, node.model) || replacementModel.variant !== node.model?.variant);
  const replacement = modelChanged || harnessChanged
    ? {
        ...(replacementModel ? { model: replacementModel } : {}),
        ...(harnessChanged && targetHarness ? { harness: targetHarness } : {}),
      }
    : undefined;
  const changed = !!replacement;
  const disabled = busy || (runStatus === "running" && !held);
  const header = harnessSlot?.({
    projectId: projectId || undefined,
    spaceId: spaceId || undefined,
    harnessSelection: targetHarness ?? { mode: "auto" },
    ...(harnessId ? { resolvedHarnessId: harnessId } : {}),
    onSelectHarness: (selection: HarnessSelection) => {
      if (disabled) return;
      setReplacementHarness(selection);
      setReplacementModel(undefined);
    },
  });
  return (
    <div className="workflow-retry-controls">
      <WorkflowRoutePicker
        value={{
          ...(replacementModel ? { model: replacementModel } : node.model ? { model: node.model } : {}),
          ...(targetHarness ? { harness: targetHarness } : {}),
        }}
        models={available}
        disabled={disabled}
        {...(header ? { header } : {})}
        onChange={(patch) => {
          if (patch.harness) setReplacementHarness(patch.harness);
          setReplacementModel(patch.model);
        }}
      />
      {changed && (
        <Checkbox
          className="workflow-retry-save"
          checked={saveToWorkflow}
          disabled={disabled}
          onChange={setSaveToWorkflow}
          label={tr("workflowview.useForFutureRuns")}
        />
      )}
      <Button
        size="sm"
        variant={primary ? "primary" : "quiet"}
        onClick={() => {
          if (disabled || (needsModel && !replacementModel)) return;
          onRetry(node.id, replacement, changed && saveToWorkflow);
        }}
        disabled={disabled || (needsModel && !replacementModel)}
      >
        {tr(held ? "workflowview.continueRun" : "workflowview.retryFailedNode")}
      </Button>
    </div>
  );
}

