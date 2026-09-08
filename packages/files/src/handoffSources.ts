import { createHash } from "node:crypto";
import type { ContextSourceRegistry } from "@polyth/handoff";
import { estimateTokens } from "@polyth/handoff";
import type { ProjectService } from "@polyth/contracts";
import type { FileService } from "./index.ts";

export function registerFilesHandoffSources(deps: {
  registry: ContextSourceRegistry;
  files: FileService;
  projects: ProjectService;
}): void {
  deps.registry.register({
    id: "file",
    label: "Selected files",
    description: "Contents of project files selected by path",
    async collect(ctx) {
      const project = await deps.projects.get(ctx.projectId);
      if (!project) return { sections: [], status: "missing" };
      const paths = Array.isArray(ctx.params?.paths)
        ? (ctx.params.paths as unknown[]).map(String).filter(Boolean)
        : [];
      if (paths.length === 0) return { sections: [], status: "missing" };
      const limit = 20;
      const selected = paths.slice(0, limit);
      const chunks: string[] = [];
      const fps: string[] = [];
      for (const rel of selected) {
        try {
          const { content } = await deps.files.read(project.path, rel);
          const hash = createHash("sha256").update(content).digest("hex");
          fps.push(`${rel}:${hash}`);
          chunks.push(`## ${rel}\n\n\`\`\`\n${content}\n\`\`\``);
        } catch {
          // invalid path or missing file
        }
      }
      if (chunks.length === 0) return { sections: [], status: "missing" };
      const body = chunks.join("\n\n");
      const result: import("@polyth/handoff").ContextCollectResult = {
        sections: [{
          title: "Files",
          body,
          fingerprint: fps.join("|"),
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
