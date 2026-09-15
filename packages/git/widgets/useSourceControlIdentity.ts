import { useEffect, useMemo, useState } from "react";
import { resolveSourceControlContext, type SourceControlResolution } from "@polyth/contracts/source-control";
import {
  setRepositorySourceControlProfile,
  useSourceControlProfileState,
} from "./sourceControlProfiles.ts";
import {
  reconcileSourceControlIdentity,
  type SourceControlRuntimeState,
} from "./sourceControlRuntime.ts";

interface ProjectRuntimeState {
  projectId: string;
  state: SourceControlRuntimeState;
}

export function useSourceControlIdentity(projectId: string) {
  const stored = useSourceControlProfileState();
  const [runtime, setRuntime] = useState<ProjectRuntimeState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setSyncing(true);
    setError("");
    void reconcileSourceControlIdentity(projectId)
      .then((next) => { if (active) setRuntime({ projectId, state: next }); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setSyncing(false); });
    return () => { active = false; };
  }, [projectId, stored]);

  const fallbackResolution = useMemo<SourceControlResolution>(() => resolveSourceControlContext({
    profiles: stored.profiles,
    repositoryProfileId: stored.repositoryProfileIds[projectId],
    globalProfileId: stored.globalDefaultProfileId,
  }), [projectId, stored.profiles, stored.repositoryProfileIds, stored.globalDefaultProfileId]);

  const currentRuntime = runtime?.projectId === projectId ? runtime.state : null;

  return {
    stored,
    currentIdentity: currentRuntime?.identity ?? null,
    resolution: currentRuntime?.resolution ?? fallbackResolution,
    syncing,
    error,
    selectProfile: (id: string | null) => {
      if (!syncing) setRepositorySourceControlProfile(projectId, id);
    },
  };
}
