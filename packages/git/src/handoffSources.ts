import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextSourceRegistry } from "@polyth/handoff";
import { estimateTokens } from "@polyth/handoff";
import type { ProjectService } from "@polyth/contracts";
import type { GitService } from "./index.ts";

export function registerGitHandoffSources(deps: {
  registry: ContextSourceRegistry;
  git: GitService;
  projects: ProjectService;
}): void {
  deps.registry.register({
    id: "git-diff",
    label: "Git diff",
    description: "Working tree diff against HEAD",
    defaultOn: true,
    async collect(ctx) {
      const project = await deps.projects.get(ctx.projectId);
      if (!project) return { sections: [], status: "missing" };
      const [{ diff }, status] = await Promise.all([
        deps.git.diff(project.path),
        deps.git.status(project.path),
      ]);
      if (!diff.trim()) return { sections: [], status: "missing" };
      const allFiles = [...status.staged, ...status.unstaged, ...status.untracked];
      const pathsKey = allFiles.map((f) => f.path).sort().join("\n");
      const fingerprint = createHash("sha256")
        .update(`${pathsKey}:${createHash("sha256").update(diff).digest("hex")}`)
        .digest("hex");
      return {
        sections: [{
          title: "Git diff",
          body: diff,
          fingerprint,
          tokens: estimateTokens(diff),
        }],
        status: "ok",
      };
    },
  });

  deps.registry.register({
    id: "changed-files",
    label: "Changed files",
    description: "Contents of files with working tree changes",
    defaultOn: true,
    async collect(ctx) {
      const project = await deps.projects.get(ctx.projectId);
      if (!project) return { sections: [], status: "missing" };
      const status = await deps.git.status(project.path);
      const filter = Array.isArray(ctx.params?.paths)
        ? (ctx.params.paths as unknown[]).map(String)
        : null;
      const paths = [...status.staged, ...status.unstaged, ...status.untracked]
        .map((f) => f.path)
        .filter((p) => !filter?.length || filter.includes(p));
      if (paths.length === 0) return { sections: [], status: "missing" };
      const limit = 20;
      const selected = paths.slice(0, limit);
      const chunks: string[] = [];
      const fps: string[] = [];
      for (const rel of selected) {
        try {
          const abs = join(project.path, rel);
          if (rel.includes("..")) continue;
          const content = await readFile(abs, "utf8");
          const hash = createHash("sha256").update(content).digest("hex");
          fps.push(`${rel}:${hash}`);
          chunks.push(`## ${rel}\n\n\`\`\`\n${content}\n\`\`\``);
        } catch {
          // skip unreadable
        }
      }
      const body = chunks.join("\n\n");
      const result: import("@polyth/handoff").ContextCollectResult = {
        sections: [{
          title: "Files",
          body,
          fingerprint: createHash("sha256").update(fps.join("|")).digest("hex"),
          tokens: estimateTokens(body),
        }],
        status: "ok",
      };
      if (paths.length > limit) {
        result.omission = {
          total: paths.length,
          included: selected.length,
          omitted: paths.length - selected.length,
          reason: "configured safety limit",
        };
      }
      return result;
    },
  });
}
