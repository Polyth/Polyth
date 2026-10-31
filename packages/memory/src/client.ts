import { ApiError, createApiTransport } from "@polyth/web-sdk";
import type {
  MemoryCategory,
  MemoryCreateInput,
  MemoryListItemDto,
  MemoryListPage,
  MemoryMode,
  MemoryExport,
  MemoryImportPreview,
  MemoryPatchInput,
  MemoryPolicyDto,
  MemoryRecordDto,
  MemoryReceiptDto,
} from "@polyth/knowledge/memory-contracts";
import {
  REFLECT_INSTRUCTION_CONFIRMATION,
  type ReflectApproveInput,
  type ReflectApproveResult,
  type ReflectInstructionFile,
  type ReflectProposalDto,
  type ReflectViewDto,
  type ReflectDurabilityArea,
  type ReflectProposalJudgmentDto,
} from "./reflectContracts.ts";

// Feature aliases keep the UI readable while all browser DTOs come from the
// canonical, Node-free Knowledge contract subpath.
export type MemoryDto = MemoryRecordDto;
export type MemoryListItem = MemoryListItemDto;
export type MemoryPolicy = MemoryPolicyDto;
export type MemoryListResponse = MemoryListPage;
export type MemoryPolicyMode = MemoryMode;
export type MemoryPolicyUpdate = Partial<Omit<MemoryPolicy, "utilityBudget">> & { utilityBudget?: { maxCalls: number } };
export type { MemoryCategory };
export type { ReflectApproveResult, ReflectInstructionFile, ReflectProposalDto, ReflectViewDto, ReflectDurabilityArea, ReflectProposalJudgmentDto };
export { REFLECT_MEMORY_OFF } from "./reflectContracts.ts";

const api = createApiTransport();
const query = (projectId: string, params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams({ projectId });
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(key, String(value));
  return search.toString();
};
const projectPath = (projectId: string): string => encodeURIComponent(projectId);

export const memoryApi = {
  list(projectId: string, params: { limit: number; offset: number; q?: string; category?: string; lifecycle?: string }, signal?: AbortSignal) {
    return api.get<MemoryListResponse>(`/api/memory?${query(projectId, params)}`, signal ? { signal } : undefined);
  },
  get(projectId: string, id: string, signal?: AbortSignal) {
    return api.get<MemoryDto>(`/api/memory/${encodeURIComponent(id)}?projectId=${projectPath(projectId)}`, signal ? { signal } : undefined);
  },
  create(input: MemoryCreateInput) {
    return api.post<MemoryReceiptDto>("/api/memory", input);
  },
  update(projectId: string, id: string, expectedRevision: number, patch: Partial<MemoryDto>) {
    return api.patch<MemoryReceiptDto>(`/api/memory/${encodeURIComponent(id)}`, { id, projectId, expectedRevision, patch } satisfies MemoryPatchInput);
  },
  action(projectId: string, id: string, action: "review" | "pin" | "lock" | "unlock" | "archive" | "forget", expectedRevision: number) {
    if (action === "forget") return api.delete<MemoryReceiptDto>(`/api/memory/${encodeURIComponent(id)}`, { id, projectId, expectedRevision, action: "forget" });
    return api.post<MemoryReceiptDto>(`/api/memory/${encodeURIComponent(id)}/${action}`, { id, projectId, expectedRevision });
  },
  clear(projectId: string, expectedGeneration: string) {
    return api.post<MemoryReceiptDto>("/api/memory/clear", { projectId, expectedGeneration, confirmation: "clear-project-memory" });
  },
  policy(projectId: string, signal?: AbortSignal) {
    return api.get<MemoryPolicy>(`/api/memory/policy?projectId=${projectPath(projectId)}`, signal ? { signal } : undefined);
  },
  updatePolicy(projectId: string, policy: MemoryPolicyUpdate & { expectedSettingsRevision: string }) {
    const { expectedSettingsRevision, ...patch } = policy;
    return api.put<MemoryPolicy>("/api/memory/policy", { projectId, expectedSettingsRevision, patch });
  },
  export(projectId: string, includeAll = false) {
    const suffix = includeAll ? "&includeArchived=1&includeCandidates=1" : "";
    return api.get<MemoryExport>(`/api/memory/export?projectId=${projectPath(projectId)}${suffix}`);
  },
  importPreview(projectId: string, expectedRevision: string, records: unknown[]) {
    return api.post<MemoryImportPreview>("/api/memory/import/preview", { projectId, expectedRevision, records });
  },
  import(projectId: string, expectedRevision: string, records: unknown[], mode: "merge" | "replace") {
    return api.post<{ imported: number; conflicts: Array<{ message: string }> }>("/api/memory/import", { projectId, expectedRevision, records, mode });
  },
};

const reflectPath = (id: string, action: "approve" | "reject" | "instruction"): string => `/api/memory/reflect/${encodeURIComponent(id)}/${action}`;
/** Only a user's explicit "also write to …" choice sends the confirmation
 * token; the server refuses an instruction write without it. */
const instructionConfirmation = (file?: ReflectInstructionFile) => file ? { instructionFile: file, confirmation: REFLECT_INSTRUCTION_CONFIRMATION } : {};

export const reflectApi = {
  view(projectId: string, signal?: AbortSignal) {
    return api.get<ReflectViewDto>(`/api/memory/reflect?projectId=${projectPath(projectId)}`, signal ? { signal } : undefined);
  },
  setEnabled(projectId: string, enabled: boolean) {
    return api.put<ReflectViewDto>("/api/memory/reflect/settings", { projectId, enabled });
  },
  scan(projectId: string) {
    return api.post<{ added: number; sessions: number }>("/api/memory/reflect/scan", { projectId });
  },
  approve(projectId: string, id: string, input: Pick<ReflectApproveInput, "rule" | "category">, instructionFile?: ReflectInstructionFile) {
    return api.post<ReflectApproveResult>(reflectPath(id, "approve"), { projectId, ...input, ...instructionConfirmation(instructionFile) });
  },
  reject(projectId: string, id: string) {
    return api.post<ReflectProposalDto>(reflectPath(id, "reject"), { projectId });
  },
  writeInstruction(projectId: string, id: string, instructionFile: ReflectInstructionFile) {
    return api.post<ReflectApproveResult>(reflectPath(id, "instruction"), { projectId, ...instructionConfirmation(instructionFile) });
  },
};

/** Host translation lookup; omitted by tests and by callers without a host. */
type ErrorTranslate = (key: string, values?: Record<string, string | number>) => string;

export function memoryError(error: unknown, translate?: ErrorTranslate): { kind: "offline" | "conflict" | "forbidden" | "unavailable" | "busy" | "corrupt" | "error"; message: string } {
  const text = (key: string, english: string): string => translate ? translate(key) : english;
  if (error instanceof DOMException && error.name === "AbortError") return { kind: "unavailable", message: text("memory.error.cancelled", "Request cancelled.") };
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return { kind: "forbidden", message: text("memory.error.readOnlyShort", "Memory is read-only for this project.") };
    if (error.status === 423 || error.code === "busy") return { kind: "busy", message: text("memory.error.busyShort", "Memory is busy; no change was reported as saved.") };
    if (error.status === 422 || error.code === "corrupt") return { kind: "corrupt", message: text("memory.error.corruptShort", "The server rejected this memory payload as invalid.") };
    if (error.status === 404 || error.status === 501) return { kind: "unavailable", message: text("memory.error.unavailableShort", "Memory service is unavailable in this server.") };
    if (error.status === 409 || error.code === "conflict") return { kind: "conflict", message: error.message };
    if (error.status === 0 || error.status >= 500) return { kind: "offline", message: error.message };
  }
  return { kind: "error", message: error instanceof Error ? error.message : String(error) };
}
