import { createApiTransport, type ApiTransport } from "@polyth/web-sdk";
import type { RepoStack, RepoStackInput, RepoStackPreview } from "./stackTypes.ts";

const query = (projectId: string): string => `?projectId=${encodeURIComponent(projectId)}`;

export interface RepoStackClient {
  list(projectId: string): Promise<{ stacks: RepoStack[] }>;
  create(stack: RepoStackInput): Promise<RepoStack>;
  remove(projectId: string, stackId: string): Promise<{ ok: true }>;
  update(projectId: string, stackId: string, patch: Partial<RepoStackInput>): Promise<RepoStack>;
  preview(projectId: string, stackId: string): Promise<RepoStackPreview>;
  restack(projectId: string, stackId: string, preview: RepoStackPreview): Promise<unknown>;
  push(projectId: string, stackId: string, input: { branch: string; remote: string; expectedRemoteSha: string; expectedLocalSha: string }): Promise<unknown>;
}

export function createRepoStackClient(transport: ApiTransport = createApiTransport()): RepoStackClient {
  return {
    list: (projectId) => transport.get(`/api/git/stacks${query(projectId)}`),
    create: (stack) => transport.post("/api/git/stacks", stack),
    remove: (projectId, stackId) => transport.delete(`/api/git/stacks/${encodeURIComponent(stackId)}${query(projectId)}`),
    update: (projectId, stackId, patch) => transport.patch(`/api/git/stacks/${encodeURIComponent(stackId)}${query(projectId)}`, patch),
    preview: (projectId, stackId) => transport.get(`/api/git/stacks/${encodeURIComponent(stackId)}/preview${query(projectId)}`),
    restack: (projectId, stackId, preview) => transport.post(`/api/git/stacks/${encodeURIComponent(stackId)}/restack`, { projectId, preview }),
    push: (projectId, stackId, input) => transport.post(`/api/git/stacks/${encodeURIComponent(stackId)}/push`, { projectId, ...input }),
  };
}
