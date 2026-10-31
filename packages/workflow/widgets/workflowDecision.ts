import type { WorkflowDecisionInputDto, WorkflowRunDto } from "@polyth/contracts";
import { sessionFetch } from "@polyth/session/web-api";

/** The person's call on a review whose rounds ran out. Kept as an object so
 * the transport is one replaceable seam, like the rest of the run API. */
export const workflowDecisionApi = {
  decide: (runId: string, input: WorkflowDecisionInputDto): Promise<WorkflowRunDto> =>
    sessionFetch<WorkflowRunDto>(`/api/workflow-runs/${encodeURIComponent(runId)}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
};
