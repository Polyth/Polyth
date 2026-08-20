// Workspace (project/session) palette search — pure matcher (WP13).
// Searches metadata only: project name/path, session title/branch/labels/
// agent/status. Transcript bodies never leave the session search endpoint.
import type { Project, SessionProjection, WorkspaceLabel, WorkspaceSearchItem } from "@polyth/contracts";

export interface MatchWorkspacesInput {
  projects: Project[];
  sessions: SessionProjection[];
  labels?: WorkspaceLabel[];
  q: string;
  limit?: number;
  /** false (default): exclude archived sessions. true: archived only. */
  archived?: boolean;
}

/** Case/diacritic fold ("Café" → "cafe"). */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const MAX_LIMIT = 100;

export function matchWorkspaces(input: MatchWorkspacesInput): WorkspaceSearchItem[] {
  const q = foldText(input.q.trim());
  const archivedOnly = input.archived === true;
  // Empty query is only meaningful behind is:archived (recent archived list).
  if (!q && !archivedOnly) return [];
  const limit = Math.max(1, Math.min(input.limit ?? 30, MAX_LIMIT));
  const labelName = new Map((input.labels ?? []).map((l) => [l.id, l.name] as const));
  const projectById = new Map(input.projects.map((p) => [p.id, p] as const));
  const out: WorkspaceSearchItem[] = [];

  for (const p of input.projects) {
    if (archivedOnly) break; // projects have no archived state; is:archived is session-only
    if (q && !foldText(p.name).includes(q) && !foldText(p.path).includes(q)) continue;
    out.push({
      kind: "project",
      id: p.id,
      projectId: p.id,
      title: p.name,
      subtitle: p.path,
      updatedAt: p.createdAt,
    });
  }

  for (const s of input.sessions) {
    const project = projectById.get(s.projectId);
    if (!project) continue; // owning project deleted — never offer a dead row
    const isArchived = s.status === "archived";
    if (archivedOnly ? !isArchived : isArchived) continue;
    const labels = (s.labelIds ?? []).map((id) => labelName.get(id)).filter((n): n is string => !!n);
    const haystacks = [s.title, s.branch ?? "", s.agent ?? "", ...labels];
    if (q && !haystacks.some((h) => h && foldText(h).includes(q))) continue;
    const subtitle = [project.name, s.branch, s.status].filter(Boolean).join(" · ");
    out.push({
      kind: "session",
      id: s.id,
      projectId: s.projectId,
      title: s.title || "(untitled session)",
      subtitle,
      ...(labels.length > 0 || s.agent ? { keywords: [...labels, ...(s.agent ? [s.agent] : [])] } : {}),
      status: s.status,
      archived: isArchived,
      updatedAt: s.updatedAt,
    });
  }

  // Projects lead (cheap to scan, few of them); sessions by recency.
  out.sort((a, b) => (a.kind === b.kind ? b.updatedAt - a.updatedAt : a.kind === "project" ? -1 : 1));
  return out.slice(0, limit);
}

/** Extract an `is:archived` token from a raw palette query. */
export function parseArchivedFilter(raw: string): { q: string; archived: boolean } {
  const archived = /(^|\s)is:archived(\s|$)/i.test(raw);
  return { q: raw.replace(/(^|\s)is:archived(?=\s|$)/gi, " ").trim(), archived };
}
