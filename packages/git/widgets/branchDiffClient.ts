import { createApiTransport, type ApiTransport } from "@polyth/web-sdk";
import type { GitBranchDiffList, GitBranchFileDiff } from "../src/index.ts";

export interface BranchReviewTarget {
  projectId: string;
  sessionId?: string | null;
  repositoryId?: string;
  base?: string;
  ignoreWhitespace?: boolean;
}

export function createBranchDiffClient(transport?: ApiTransport) {
  const read = (target: BranchReviewTarget, path?: string) => {
    const query = new URLSearchParams({ projectId: target.projectId });
    if (target.sessionId) query.set("sessionId", target.sessionId);
    if (target.repositoryId) query.set("repositoryId", target.repositoryId);
    if (target.base) query.set("base", target.base);
    if (target.ignoreWhitespace) query.set("ignoreWhitespace", "true");
    if (path !== undefined) query.set("path", path);
    return (transport ?? createApiTransport()).get(`/api/git/branch-diff?${query}`);
  };
  return {
    list: (target: BranchReviewTarget) => read(target) as Promise<GitBranchDiffList>,
    file: (target: BranchReviewTarget, path: string) => read(target, path) as Promise<GitBranchFileDiff>,
  };
}
