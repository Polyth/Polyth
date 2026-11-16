// Host side of `TURN_CONTEXT`: package contributors to the hidden context of an
// admitted user message. The session service calls `collect` once per admitted
// turn and persists the result before runtime delivery.
import type { SpaceContext } from "@polyth/contracts";
import type { TurnContextContributor, TurnContextRegistry } from "@polyth/plugins";

export const TURN_CONTEXT_BUDGET_MS = 150;
export const TURN_CONTEXT_MAX_BYTES = 2048;

export interface TurnContextCollector {
  collect(input: { spaceId: string; sessionId: string; projectId: string; userId: string | undefined; worktreePath: string | undefined }): Promise<string>;
}

export function createTurnContextRegistry(deps: {
  space(spaceId: string): SpaceContext;
  budgetMs?: number;
  maxBytes?: number;
  log?: (message: string, error?: unknown) => void;
}): TurnContextRegistry & TurnContextCollector {
  const contributors = new Set<TurnContextContributor>();
  const warned = new WeakSet<TurnContextContributor>();
  const budgetMs = deps.budgetMs ?? TURN_CONTEXT_BUDGET_MS;
  const maxBytes = deps.maxBytes ?? TURN_CONTEXT_MAX_BYTES;
  const log = deps.log ?? ((message, error) => console.warn(message, error));
  return {
    register(contributor) {
      contributors.add(contributor);
      return { dispose: () => { contributors.delete(contributor); } };
    },
    async collect(input) {
      if (!contributors.size) return "";
      let space: SpaceContext;
      try { space = deps.space(input.spaceId); } catch { return ""; }
      const scope = { space, sessionId: input.sessionId, projectId: input.projectId, userId: input.userId, worktreePath: input.worktreePath };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), budgetMs); });
      try {
        const settled = [...contributors].map(async (contributor): Promise<string> => {
          try {
            const text = await Promise.race([Promise.resolve().then(() => contributor(scope)), deadline]);
            if (text === "timeout") throw new Error(`exceeded ${budgetMs} ms`);
            return typeof text === "string" ? text.trim() : "";
          } catch (error) {
            if (!warned.has(contributor)) {
              warned.add(contributor);
              log("[polyth] turn context contributor skipped", error);
            }
            return "";
          }
        });
        const blocks = (await Promise.all(settled)).filter(Boolean);
        // Whole blocks only: a truncated block would be an unterminated tag.
        const kept: string[] = [];
        let bytes = 0;
        for (const block of blocks) {
          const size = Buffer.byteLength(block, "utf8") + (kept.length ? 2 : 0);
          if (bytes + size > maxBytes) continue;
          kept.push(block);
          bytes += size;
        }
        return kept.join("\n\n");
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
