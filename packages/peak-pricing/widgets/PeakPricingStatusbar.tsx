// The peak-pricing segment of the status bar. The bar gives its widgets only
// the active project and session, so the route comes from the host: the open
// session's model and resolved harness, or a new chat's draft route. That is
// the route the next turn takes once it is sent; an unsent model switch in the
// composer is the composer chip's to show.
import { useSyncExternalStore } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import PeakPricingIndicator, { type PeakPricingModel } from "./PeakPricingIndicator.tsx";

export interface PeakPricingStatusbarProps {
  host: WebPackageHost;
  projectId: string | null;
  sessionId: string | null;
}

/** `harness\0provider\0model`, so the store snapshot is a stable primitive. */
function routeKey(host: WebPackageHost, projectId: string | null, sessionId: string | null): string {
  if (sessionId) {
    const session = host.sessions.get(sessionId);
    if (!session?.model) return "";
    return [session.resolvedHarnessId ?? "", session.model.providerID, session.model.modelID].join("\0");
  }
  if (!projectId) return "";
  const model = host.executionDraft.get(projectId).model;
  return model ? [model.harnessId, model.providerID, model.modelID].join("\0") : "";
}

function subscribeRoute(host: WebPackageHost, listener: () => void): () => void {
  const offSessions = host.sessions.subscribe(listener);
  const offDraft = host.executionDraft.subscribe(listener);
  return () => {
    offSessions();
    offDraft();
  };
}

export default function PeakPricingStatusbar({ host, projectId, sessionId }: PeakPricingStatusbarProps) {
  const key = useSyncExternalStore(
    (listener) => subscribeRoute(host, listener),
    () => routeKey(host, projectId, sessionId),
    () => "",
  );
  if (!key) return null;
  const [harnessId = "", providerID = "", modelID = ""] = key.split("\0");
  const model: PeakPricingModel = { providerID, modelID, ...(harnessId ? { harnessId } : {}) };
  return <PeakPricingIndicator model={model} surface="statusbar" {...(harnessId ? { harnessId } : {})} />;
}
