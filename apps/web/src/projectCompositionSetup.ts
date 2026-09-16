import type { Project } from "@polyth/contracts";
import type { ProjectComposition } from "@polyth/contracts/project-composition";

export interface ProjectSetupInput {
  mode: "add" | "create";
  path: string;
  name?: string;
  composition: ProjectComposition;
}

/** Composition-aware creation is project-owned and atomic on the server.
 * Legacy add/create stays compatible while onboarding opts into this contract. */
export async function setupProject(input: ProjectSetupInput): Promise<Project> {
  const response = await fetch("/api/projects/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("polyth:auth-required"));
    const raw = await response.text().catch(() => "");
    let code: string | undefined;
    let message: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === "string") code = parsed.error;
      if (typeof parsed.message === "string") message = parsed.message;
    } catch { /* non-JSON error */ }
    throw Object.assign(new Error(message ?? `HTTP ${response.status}${raw ? `: ${raw}` : ""}`), {
      ...(code ? { code } : {}),
      status: response.status,
    });
  }
  return response.json() as Promise<Project>;
}
