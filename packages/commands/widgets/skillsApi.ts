import type {
  CapabilityInstallationScope,
  SkillAdoptInput,
  SkillCatalogDetailDto,
  SkillCatalogDto,
  SkillCatalogInstallInput,
  SkillCatalogSourceDto,
  SkillFilePreviewDto,
  SkillInstallationDto,
  SkillInstallationInput,
  SkillLibraryDetailDto,
  SkillLibraryDto,
  SkillReachInput,
} from "@polyth/contracts/capability-installations";
import { createApiTransport } from "@polyth/web-sdk";

const api = createApiTransport();

const query = (params: Record<string, string | null | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
};
const owner = (projectId: string | null | undefined) => (projectId ? { projectId } : {});

export const skillsApi = {
  /** `fresh` names a harness whose own skills just changed, or `all`. */
  library: (projectId?: string | null, fresh?: string) =>
    api.get<SkillLibraryDto>(`/api/skills/library${query({ projectId, fresh })}`),
  libraryDetail: (name: string, projectId?: string | null) =>
    api.get<SkillLibraryDetailDto>(`/api/skills/library/skill${query({ name, projectId })}`),
  libraryFile: (name: string, path: string, projectId?: string | null) =>
    api.get<SkillFilePreviewDto>(`/api/skills/library/file${query({ name, path, projectId })}`),
  catalog: (projectId?: string | null) =>
    api.get<SkillCatalogDto>(`/api/skills/catalog${query({ projectId })}`),
  catalogDetail: (id: string, projectId?: string | null) =>
    api.get<SkillCatalogDetailDto>(`/api/skills/catalog/skill${query({ id, projectId })}`),
  catalogFile: (id: string, path: string) =>
    api.get<SkillFilePreviewDto>(`/api/skills/catalog/file${query({ id, path })}`),
  install: (input: SkillCatalogInstallInput) =>
    api.post<SkillInstallationDto>("/api/skills/catalog/install", input),
  addSource: (url: string) =>
    api.post<SkillCatalogSourceDto>("/api/skills/catalog/sources", { url }),
  removeSource: (id: string) =>
    api.request<{ ok: boolean }>("/api/skills/catalog/sources", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }),
  refresh: (id?: string) =>
    api.post<{ ok: boolean }>("/api/skills/catalog/refresh", id ? { id } : {}),
  adopt: (input: SkillAdoptInput) =>
    api.post<SkillInstallationDto>("/api/skills/library/adopt", input),
  reach: (input: SkillReachInput) =>
    api.post<SkillInstallationDto>("/api/skills/library/reach", input),
  update: (scope: CapabilityInstallationScope, name: string, projectId?: string) =>
    api.post<SkillInstallationDto>("/api/skills/library/update", { scope, name, ...owner(projectId) }),
  save: (scope: CapabilityInstallationScope, input: SkillInstallationInput, projectId?: string | null) =>
    api.post<SkillInstallationDto>("/api/skills", { scope, ...owner(projectId), ...input }),
  remove: (scope: CapabilityInstallationScope, name: string, projectId?: string, expectedRevision?: number) =>
    api.request<{ ok: boolean }>("/api/skills", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope,
        name,
        ...owner(projectId),
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    }),
  nativeSkill: (harnessId: string, name: string, enabled: boolean, projectId?: string | null) =>
    api.put(`/api/harnesses/${encodeURIComponent(harnessId)}/skills${query({ projectId })}`, { skill: { name, enabled } }),
};
