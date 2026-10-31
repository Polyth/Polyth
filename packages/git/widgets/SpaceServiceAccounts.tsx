// Space admins: whether agents may fall back to the Space's shared (service)
// hosting accounts (Spaces §14.4). Members never see this: their own accounts
// apply to them automatically. Which account a project is bound to lives on
// the This project tab (`SourceControlAccountSetting`).
import { useEffect, useState } from "react";
import { api, sessionFetch } from "@polyth/session/web-api";
import { ErrorState, Row, SaveStatus, Section, Toggle } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";

export const SERVICE_POLICY_PATH = "/api/git/service-policy";
export const SERVICE_POLICY_ITEM = "git.servicePolicy";

/** Whether the signed-in person administers the active Space. Best effort:
 *  unknown reads as no, and the server still checks every write. */
export function useSpaceAdmin(): boolean {
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    let live = true;
    void api.spaces().then((state) => {
      const active = state.spaces.find((space) => space.id === state.activeSpaceId);
      if (live) setAdmin(active?.role === "owner" || active?.role === "admin");
    }).catch(() => { if (live) setAdmin(false); });
    return () => { live = false; };
  }, []);
  return admin;
}

export default function SpaceServiceAccounts() {
  const [policy, setPolicy] = useState<{ agentsMayUseService: boolean } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setLoadError(null);
    void sessionFetch<{ agentsMayUseService: boolean }>(SERVICE_POLICY_PATH)
      .then((next) => { if (live) setPolicy(next); })
      .catch((cause: unknown) => { if (live) setLoadError(cause); });
    return () => { live = false; };
  }, [reload]);
  const change = async (agentsMayUseService: boolean) => {
    const previous = policy;
    setPolicy({ agentsMayUseService });
    setStatus("saving");
    setError("");
    try {
      setPolicy(await sessionFetch<{ agentsMayUseService: boolean }>(SERVICE_POLICY_PATH, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentsMayUseService }),
      }));
      setStatus("saved");
    } catch (cause) {
      setPolicy(previous);
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <Section
      title={tr("gitsettings.spacePolicyTitle")}
      hint={tr("gitsettings.spacePolicyHint")}
      itemId={SERVICE_POLICY_ITEM}
      {...(status !== "idle" ? { action: <SaveStatus state={status} {...(error ? { error } : {})} /> } : {})}
    >
      {loadError && !policy
        ? <ErrorState compact error={loadError} onRetry={() => setReload((n) => n + 1)} />
        : (
          <Row label={tr("gitsettings.agentsMayUse")} hint={tr("gitsettings.agentsMayUseHint")}>
            <Toggle
              on={policy?.agentsMayUseService ?? false}
              disabled={!policy || status === "saving"}
              label={tr("gitsettings.agentsMayUse")}
              onChange={(on) => void change(on)}
            />
          </Row>
        )}
    </Section>
  );
}
