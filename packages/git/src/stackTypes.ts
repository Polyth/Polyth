export interface RepoStackEntry { branch: string; baseBranch: string; headSha: string; baseSha: string; provider?: string; prNumber?: number; url?: string; title?: string; checks?: { passed: number; total: number; state: "success" | "pending" | "failure" | "none" }; review?: "approved" | "changes-requested" | "pending" | "none"; changedFiles?: number }
export interface RepoStack { id: string; projectId: string; repositoryId: string; baseBranch: string; entries: RepoStackEntry[] }
export type RepoStackEntryInput = Omit<RepoStackEntry, "headSha" | "baseSha"> & { headSha?: string; baseSha?: string };
export type RepoStackInput = Omit<RepoStack, "entries"> & { entries: RepoStackEntryInput[] };
export interface RepoStackPreviewEntry { branch: string; fromBaseBranch: string; ontoBaseBranch: string; expectedHeadSha: string; expectedBaseSha: string; expectedOntoSha: string; plannedHeadSha: string; remote?: string; expectedRemoteSha?: string }
export interface RepoStackPreview { stackId: string; projectId: string; repositoryId: string; expectedFingerprint: string; entries: RepoStackPreviewEntry[]; warnings: string[]; requiresRemoteForceWithLease: boolean }
export interface RepoStackApplyOutcome { branch: string; ok: boolean; oldSha: string; newSha?: string; ontoSha?: string; receipt?: string; reason?: string; cleanupError?: string }
export interface RepoStackApplyResult { stackId: string; projectId: string; repositoryId: string; outcomes: RepoStackApplyOutcome[]; partial: boolean }
export interface RepoStackPushResult { branch: string; remote: string; expectedRemoteSha: string; newSha: string; receipt: string }
