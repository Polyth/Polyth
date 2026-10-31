/** Browser-safe DTOs for project CLI panels. Paths are display context, never authority. */
export interface ProjectToolInput {
  projectId: string;
  sessionId?: string | null;
  repositoryId?: string | null;
}

export interface ProjectToolScope extends ProjectToolInput {
  repositoryId: string;
  root: string;
  alias: string;
  repositories: Array<{ id: string; alias: string; available: boolean }>;
}

export interface ToolCommandPreview {
  title: string;
  explanation: string;
  cmd: string;
  cwd: string;
  projectId: string;
  sessionId?: string | null;
  repositoryId: string;
}

export interface ToolAvailability {
  available: boolean;
  reason?: "read-only-preview";
  version?: string;
  message?: string;
}
