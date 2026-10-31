import { createApiTransport, type ApiTransport } from "@polyth/web-sdk";
import type { AudioAnalysis } from "../src/audio/analysis.ts";
import type { RenderJob, StudioInit, StudioPatch, StudioState } from "../src/index.ts";

const BASE = "/api/creative-studio";

const qs = (values: Record<string, string | undefined>) =>
  Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${encodeURIComponent(value!)}`).join("&");

export interface StudioScope { projectId: string; sessionId: string }

export interface StateResponse {
  unchanged?: boolean;
  revision: string | null;
  state?: StudioState | null;
}

export function createStudioClient(transport: ApiTransport = createApiTransport({ readRetry: false })) {
  return {
    state: (scope: StudioScope, since?: string) =>
      transport.get<StateResponse>(`${BASE}/state?${qs({ ...scope, since })}`),
    init: (scope: StudioScope, init: StudioInit) =>
      transport.post<{ state: StudioState }>(`${BASE}/state`, { ...scope, init }),
    patch: (scope: StudioScope, patch: StudioPatch) =>
      transport.post<{ state: StudioState }>(`${BASE}/state`, { ...scope, patch }),
    analysis: (scope: StudioScope) =>
      transport.get<{ analysis: AudioAnalysis | null }>(`${BASE}/analysis?${qs({ ...scope })}`),
    scenes: (scope: StudioScope) =>
      transport.get<{ codes: Record<string, string | undefined> }>(`${BASE}/scenes?${qs({ ...scope })}`),
    analyze: (scope: StudioScope, input: { audioPath?: string; lyricsText?: string } = {}) =>
      transport.post<Record<string, unknown>>(`${BASE}/analyze`, { ...scope, ...input }),
    render: (scope: StudioScope, kind: "stills" | "preview" | "final") =>
      transport.post<{ job?: RenderJob }>(`${BASE}/render`, { ...scope, kind }),
    cancel: (scope: StudioScope) => transport.post<{ cancelled: boolean }>(`${BASE}/render/cancel`, { ...scope }),
    three: () => transport.get<{ core: string; module: string }>(`${BASE}/vendor/three`),
    async upload(scope: StudioScope, file: File): Promise<{ path: string; kind: "audio" | "lyrics" }> {
      return transport.request(`${BASE}/upload?${qs({ ...scope, name: file.name })}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      });
    },
  };
}

export type StudioClient = ReturnType<typeof createStudioClient>;

/** Same-origin URL for a studio media file (stills, renders, the song). */
export function mediaUrl(scope: StudioScope, path: string, version?: string | number): string {
  return `${BASE}/media?${qs({ ...scope, path, ...(version !== undefined ? { v: String(version) } : {}) })}`;
}
