// The Planner's own HTTP client. Routes live in `../src/serverEntry.ts`.
import { sessionFetch } from "@polyth/session/web-api";
import type {
  PlannerCadence,
  PlannerPreview,
  PlannerRunRecord,
  PlannerTask,
  PlannerTaskInput,
} from "../src/model.ts";

const BASE = "/api/planner";
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
});
const at = (id: string, action?: string) => `${BASE}/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

const isTask = (value: unknown): value is PlannerTask =>
  !!value && typeof value === "object"
  && typeof (value as PlannerTask).id === "string"
  && typeof (value as PlannerTask).prompt === "string";

export const plannerApi = {
  async list(): Promise<PlannerTask[]> {
    const response = await sessionFetch<{ tasks?: unknown }>(BASE);
    return Array.isArray(response?.tasks) ? response.tasks.filter(isTask) : [];
  },
  create: (input: PlannerTaskInput) => sessionFetch<PlannerTask>(BASE, json("POST", input)),
  update: (id: string, patch: Partial<PlannerTaskInput>) => sessionFetch<PlannerTask>(at(id), json("PATCH", patch)),
  remove: (id: string) => sessionFetch<{ ok: boolean }>(at(id), json("DELETE")),
  setPaused: (id: string, paused: boolean) => sessionFetch<PlannerTask>(at(id, paused ? "pause" : "resume"), json("POST")),
  run: (id: string) => sessionFetch<PlannerTask>(at(id, "run"), json("POST")),
  runs: (id: string, limit = 50) => sessionFetch<PlannerRunRecord[]>(`${at(id, "runs")}?limit=${limit}`),
  preview: (cadence: PlannerCadence, count = 3) =>
    sessionFetch<PlannerPreview>(`${BASE}/preview`, json("POST", { cadence, count })),
};
