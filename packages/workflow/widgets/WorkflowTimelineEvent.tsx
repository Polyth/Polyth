// The workflow timeline card, contributed through the generic
// `session.timeline.event` slot. The shell anchors it at its
// `workflow/run-started` sequence and renders it with the rest of history; the
// package folds the run's later events itself so the card stays live.
import { useMemo } from "react";
import type { SessionEvent } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";
import WorkflowTimelineCard from "./WorkflowTimelineCard.tsx";
import { workflowRunFromStartedEvent } from "./workflowRunProjection.ts";

export default function WorkflowTimelineEvent({ host, event, sessionId }: {
  host: WebPackageHost;
  event: SessionEvent;
  sessionId: string;
}) {
  const events = host.sessions.events(sessionId);
  const run = useMemo(
    () => workflowRunFromStartedEvent(event, events),
    [event, events],
  );
  if (!run) return null;
  return <WorkflowTimelineCard run={run} />;
}
