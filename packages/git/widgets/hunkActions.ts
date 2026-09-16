export type GitHunkOperation = "stage" | "unstage" | "discard";

export interface GitHunkActionInput {
  projectId: string;
  sessionId?: string;
  path: string;
  hunkIndex: number;
  hunkDigest: string;
  expectedSnapshotDigest: string;
  expectedStaged: boolean;
  ignoreWhitespace?: boolean;
}

export async function mutateGitHunk(operation: GitHunkOperation, input: GitHunkActionInput): Promise<void> {
  const res = await fetch(`/api/git/hunk/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.ok) return;
  let message = `Git hunk update failed (${res.status})`;
  try {
    const payload = await res.json() as { message?: unknown };
    if (typeof payload.message === "string" && payload.message.trim()) message = payload.message;
  } catch {}
  throw new Error(message);
}

export function gitDiffSnapshotDigestOf(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const value = (result as { snapshotDigest?: unknown }).snapshotDigest;
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : "";
}
