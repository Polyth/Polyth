import { useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { WorkflowIcon } from "../../../apps/web/src/components/ui/index.ts";

/** Marks a session owned by a workflow run in the navigator. The durable
 * marker is the package-owned session purpose, so the badge survives reloads
 * without a per-row run lookup. */
export default function WorkflowSessionBadge({ sessionId }: { sessionId: string }) {
  const purpose = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === sessionId)?.purpose
  );
  if (purpose !== "workflow") return null;
  const label = tr("workflowtimeline.workflow");
  return (
    <span className="workflow-session-badge" title={label} aria-label={label}>
      <WorkflowIcon aria-hidden="true" />
    </span>
  );
}
