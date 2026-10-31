import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import type { RouteHandler } from "@polyth/contracts";
import { createActionStore } from "./actionStore.ts";
import { createRunManager, type RunManager, type RunTerminals, type StartChatInput } from "./runManager.ts";
import { CUSTOM_ACTION_REMOTE_ACCESS, customActionRoutes } from "./routes.ts";

/** Create the hand-off chat in the run's project and send its first message.
 *  A chat launched from a session reuses that session's plain worktree, so the
 *  agent sees the checkout the command ran in. */
async function startChat(host: ServerPackageHost, input: StartChatInput): Promise<string> {
  const scoped = host.forSpace(input.space);
  let worktreePath: string | undefined;
  if (input.contextSessionId) {
    const context = await scoped.sessions.snapshot(input.contextSessionId).catch(() => undefined);
    if (context?.projectId === input.projectId && context.worktreePath && !context.isolation
      && context.worktreeState !== "missing") {
      worktreePath = context.worktreePath;
    }
  }
  const { chat } = input;
  const ref = await scoped.sessions.create({
    projectId: input.projectId,
    ...(chat.harnessId ? { harness: { mode: "pinned" as const, harnessId: chat.harnessId } } : {}),
    ...(chat.model ? { model: chat.model } : {}),
    ...(worktreePath ? { worktreePath } : {}),
  });
  try {
    await scoped.sessions.send(ref.id, { text: input.text, ...(chat.model ? { model: chat.model } : {}) });
  } catch (error) {
    // The chat exists; its message was not confirmed. Never resend blindly.
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { sessionId: ref.id });
  }
  return ref.id;
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let runtime: { routes: RouteHandler; runs: RunManager } | null = null;
  const log = (message: string) => console.warn(message);
  return {
    remoteAccess: CUSTOM_ACTION_REMOTE_ACCESS,
    routes: async (request) => runtime ? runtime.routes(request) : false,
    onEnable() {
      if (runtime) return;
      // Resolved per run: the terminal package may load after this one.
      const runs = createRunManager({
        terminals: () => host.services.get(serverServiceKey<RunTerminals>("terminal")),
        startChat: (input) => startChat(host, input),
        log,
      });
      runtime = {
        runs,
        routes: customActionRoutes({
          store: createActionStore({ storage: (space) => host.spaceStorage(space), log }),
          runs,
          forSpace: (space) => host.forSpace(space),
        }),
      };
    },
    async onDisable() {
      const current = runtime;
      runtime = null;
      await current?.runs.dispose();
    },
  };
}
