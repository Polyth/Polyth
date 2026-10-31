// REST client for the custom-action server routes. Mutations are sent once
// (no transport retry): a lost response must not save or start anything twice.
import { createApiTransport } from "@polyth/web-sdk";
import type {
  ActionRunDto,
  ActionRunOutputDto,
  CustomActionDto,
  CustomActionInput,
  CustomActionListDto,
} from "../src/actionModel.ts";

const reads = createApiTransport();
const writes = createApiTransport({ readRetry: false });
const BASE = "/api/custom-action";
const id = (value: string) => encodeURIComponent(value);

export type ActionListResponse = CustomActionListDto & { blocked: string | null };

export const actionApi = {
  list: () => reads.get<ActionListResponse>(`${BASE}/actions`),
  create: (input: CustomActionInput) => writes.post<{ action: CustomActionDto }>(`${BASE}/actions`, input),
  update: (actionId: string, input: CustomActionInput) => writes.put<{ action: CustomActionDto }>(`${BASE}/actions/${id(actionId)}`, input),
  remove: (actionId: string) => writes.delete<{ ok: true }>(`${BASE}/actions/${id(actionId)}`),
  reorder: (ids: readonly string[]) => writes.put<{ actions: CustomActionDto[] }>(`${BASE}/order`, { ids }),
  run: (actionId: string, context: { projectId: string; sessionId: string | null }) =>
    writes.post<{ run: ActionRunDto; joined: boolean }>(`${BASE}/actions/${id(actionId)}/run`, {
      projectId: context.projectId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    }),
  runs: () => reads.get<{ runs: ActionRunDto[] }>(`${BASE}/runs`),
  output: (runId: string, from: number) => reads.get<ActionRunOutputDto>(`${BASE}/runs/${id(runId)}/output?from=${Math.max(0, Math.floor(from))}`),
  stop: (runId: string) => writes.post<{ run: ActionRunDto }>(`${BASE}/runs/${id(runId)}/stop`),
  /** Terminal actions run in an ordinary Terminal tab owned by the terminal package. */
  openTerminal: (input: { projectId: string; sessionId: string | null; cmd: string }) =>
    writes.post<{ terminalId: string }>("/api/terminals", {
      projectId: input.projectId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      cmd: input.cmd,
    }),
  renameTerminal: (terminalId: string, title: string) =>
    writes.patch<{ ok: true }>(`/api/terminals/${id(terminalId)}`, { title }),
};
