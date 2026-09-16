export interface PromptPrefixContributorDiagnostic {
  id: string;
  kind: string;
  owner: string;
  scope: string;
  revision: string;
}

export interface PromptPrefixDiagnostics {
  version: 1;
  coverage: "polyth-capability-prefix";
  harnessId?: string;
  identity: string;
  bundleRevision: string;
  contributorCount: number;
  contributors: PromptPrefixContributorDiagnostic[];
}

export async function fetchPromptPrefixDiagnostics(
  projectId: string,
  sessionId: string,
): Promise<PromptPrefixDiagnostics> {
  const query = new URLSearchParams({ projectId, sessionId });
  const response = await fetch(`/api/harnesses/prompt-prefix-diagnostics?${query}`);
  if (!response.ok) throw new Error(`Prompt prefix diagnostics unavailable (${response.status})`);
  return response.json() as Promise<PromptPrefixDiagnostics>;
}
