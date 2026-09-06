import { useEffect, useState } from "react";
import type { AgentDescriptor, ModelDescriptor, SessionProjection } from "@polyth/contracts";
import { createApiTransport } from "@polyth/web-sdk";
const api = createApiTransport();
type Catalog = { models: ModelDescriptor[]; agents: AgentDescriptor[]; nativeDefault: boolean };
const unavailable: Catalog = { models: [], agents: [], nativeDefault: false };
export function useRuntimeCatalog(session: SessionProjection | null, models: ModelDescriptor[], agents: AgentDescriptor[]): Catalog {
  const key = session?.id ? `${session.id}:${session.resolvedHarnessId ?? ""}:${session.harnessTransition?.id ?? ""}` : "";
  const [result, setResult] = useState<{ key: string; catalog: Catalog }>();
  useEffect(() => {
    if (!session?.id || session.harnessTransition) return;
    let cancelled = false;
    void api.get<Catalog>(`/api/runtime-catalog?sessionId=${encodeURIComponent(session.id)}`).then((catalog) => { if (!cancelled) setResult({ key, catalog }); }).catch(() => { if (!cancelled) setResult({ key, catalog: unavailable }); });
    return () => { cancelled = true; };
  }, [key]);
  return !key ? { models, agents, nativeDefault: false } : result?.key === key ? result.catalog : unavailable;
}
