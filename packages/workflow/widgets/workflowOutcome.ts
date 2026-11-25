import type { WorkflowOutcomeInputDto, WorkflowRunDto } from "@polyth/contracts";
import { sessionFetch } from "@polyth/session/web-api";

/** How the run's result was used, recorded by its launcher once it has
 * settled. One replaceable seam, like the decision call; a later record
 * replaces the earlier one. */
export const workflowOutcomeApi = {
  record: (runId: string, input: WorkflowOutcomeInputDto): Promise<WorkflowRunDto> =>
    sessionFetch<WorkflowRunDto>(`/api/workflow-runs/${encodeURIComponent(runId)}/outcome`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
};
