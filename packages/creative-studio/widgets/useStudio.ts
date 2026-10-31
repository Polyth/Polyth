import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AudioAnalysis } from "../src/audio/analysis.ts";
import type { StudioState } from "../src/index.ts";
import type { StudioClient, StudioScope } from "./client.ts";

export interface StudioData {
  loading: boolean;
  error: string;
  state: StudioState | null;
  analysis: AudioAnalysis | null;
  codes: Record<string, string | undefined>;
  refresh(): Promise<void>;
  /** Apply a state the server just returned (after a POST). */
  accept(state: StudioState): void;
}

/** Poll delay: fast while the agent works or a render runs. */
export function pollDelay(input: { active: boolean; working: boolean; rendering: boolean; failed: boolean; exists: boolean }): number {
  if (!input.active) return 4000;
  if (input.failed) return 5000;
  if (input.rendering) return 700;
  if (input.working) return 900;
  return input.exists ? 2500 : 3000;
}

/** Key that changes when any scene's code may have changed. */
export const codesKey = (state: StudioState | null): string =>
  state ? state.scenes.map((scene) => `${scene.id}:${scene.revision}`).join("|") : "";

const NO_CODES: Record<string, string | undefined> = {};

export function useStudio(client: StudioClient, scope: StudioScope | null, options: { active: boolean; working: boolean; friendly: (action: string, cause: unknown) => string; loadFailed: string }): StudioData {
  const [state, setState] = useState<StudioState | null>(null);
  const [analysis, setAnalysis] = useState<AudioAnalysis | null>(null);
  const [codes, setCodes] = useState<Record<string, string | undefined>>({});
  const [loading, setLoading] = useState(Boolean(scope));
  const [error, setError] = useState("");
  const revision = useRef<string | null>(null);
  const scopeKey = scope ? `${scope.projectId}:${scope.sessionId}` : "";
  const generation = useRef(0);
  // The scope the held data belongs to. A render right after the chat changed
  // (before the reset effect) must not show the previous chat's studio.
  const [owner, setOwner] = useState(scopeKey);

  useEffect(() => {
    generation.current += 1;
    revision.current = null;
    setOwner(scopeKey);
    setState(null);
    setAnalysis(null);
    setCodes({});
    setError("");
    setLoading(Boolean(scope));
  }, [scopeKey]);

  const refresh = useCallback(async () => {
    if (!scope) return;
    const owned = generation.current;
    try {
      const response = await client.state(scope, revision.current ?? undefined);
      if (owned !== generation.current) return;
      setLoading(false);
      setError("");
      if (response.unchanged) return;
      revision.current = response.revision;
      setState(response.state ?? null);
    } catch (cause) {
      if (owned !== generation.current) return;
      setLoading(false);
      setError(options.friendly(options.loadFailed, cause));
      throw cause;
    }
  }, [client, scopeKey]);

  const rendering = Boolean(state?.renders.some((job) => job.status === "running"));
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let failed = false;
      try { await refresh(); } catch { failed = true; }
      if (cancelled) return;
      timer = setTimeout(tick, pollDelay({ active: options.active, working: options.working, rendering, failed, exists: Boolean(state) }));
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, options.active, options.working, rendering, Boolean(state)]);

  const analyzedAt = state?.audio?.analyzedAt;
  useEffect(() => {
    if (!scope || !analyzedAt) { setAnalysis(null); return; }
    const owned = generation.current;
    client.analysis(scope).then((response) => { if (owned === generation.current) setAnalysis(response.analysis); }, () => undefined);
  }, [client, scopeKey, analyzedAt]);

  const key = codesKey(state);
  useEffect(() => {
    if (!scope || !key) { setCodes({}); return; }
    const owned = generation.current;
    client.scenes(scope).then((response) => { if (owned === generation.current) setCodes(response.codes); }, () => undefined);
  }, [client, scopeKey, key]);

  const accept = useCallback((next: StudioState) => {
    revision.current = null;
    setState(next);
  }, []);

  const current = owner === scopeKey;
  return useMemo(() => current
    ? { loading, error, state, analysis, codes, refresh, accept }
    : { loading: Boolean(scope), error: "", state: null, analysis: null, codes: NO_CODES, refresh, accept },
  [current, loading, error, state, analysis, codes, refresh, accept, scope]);
}
