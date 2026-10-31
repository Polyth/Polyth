import type { ModelRef, RouteHandler } from "@polyth/contracts";
import { JUDGMENT_SERVICE } from "@polyth/judgment/server";
import {
  localOnlyRemoteAccess,
  publishBackgroundWork,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createMultirunService, type MultirunRunSpec, type MultirunService } from "./index.ts";
import { createMultirunRunOne } from "./runner.ts";
import { multirunRubricScoreUse } from "./rubric.ts";
import { scoreMultirunAnswers, type RubricJudgmentPort } from "./scoring.ts";

const asModel = (value: unknown): ModelRef | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const model = value as { providerID?: unknown; modelID?: unknown };
  return typeof model.providerID === "string" && typeof model.modelID === "string"
    ? { providerID: model.providerID, modelID: model.modelID }
    : undefined;
};

export function multirunRoutes(multirun: MultirunService): RouteHandler {
  return async (rc) => {
    const { path, method, body, json } = rc;
    let match = path.match(/^\/api\/sessions\/([^/]+)\/multirun$/);
    if (match && method === "POST") {
      const input = await body();
      const runs: MultirunRunSpec[] = Array.isArray(input.runs)
        ? input.runs.map((candidate) => {
            const raw = (candidate ?? {}) as Record<string, unknown>;
            const model = asModel(raw.model);
            const agent = typeof raw.agent === "string" ? raw.agent : undefined;
            return { ...(model ? { model } : {}), ...(agent ? { agent } : {}) };
          })
        : [];
      const { id } = await multirun.start(match[1]!, {
        text: String(input.text ?? ""),
        runs,
      }, { space: rc.space });
      json(200, { multirunId: id });
      return true;
    }
    match = path.match(/^\/api\/multiruns\/([^/]+)\/pick$/);
    if (match && method === "POST") {
      const input = await body();
      await multirun.pick(match[1]!, String(input.runId ?? ""));
      json(200, { ok: true });
      return true;
    }
    match = path.match(/^\/api\/multiruns\/([^/]+)$/);
    if (match && method === "GET") {
      const state = multirun.get(match[1]!);
      if (!state) {
        json(404, { error: "not-found" });
        return true;
      }
      json(200, multirun.snapshot(state));
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // The use may register before or after the Judgment package enables; retry
  // lazily on the first scoring pass when it was absent at enable time.
  let useDisposer: (() => void) | undefined;
  let registeredWith: unknown;
  const ensureUseRegistered = (): void => {
    const judgment = host.services.get(JUDGMENT_SERVICE);
    if (!judgment || registeredWith === judgment) return;
    try {
      useDisposer = judgment.registerUse(multirunRubricScoreUse());
    } catch {
      // Another registration already owns this id; either way it is now present.
    }
    registeredWith = judgment;
  };
  ensureUseRegistered();

  // M3: runs resolve the parent session's project/runtime lazily, so they
  // work for any session without composition-root wiring.
  const multirun = createMultirunService({
    append: async (sessionId, type, data) => {
      const event = await host.events.append(sessionId, type, data, { ignorable: true });
      const id = typeof data.multirunId === "string" ? data.multirunId : "";
      if (id && type === "multirun/started") {
        await publishBackgroundWork(host, sessionId, "multirun", { phase: "started", id });
      } else if (id && type === "multirun/completed") {
        await publishBackgroundWork(host, sessionId, "multirun", {
          phase: "completed",
          id,
          status: "completed",
        });
      }
      return event;
    },
    runOne: createMultirunRunOne(
      (sessionId) => host.resolveSessionRuntime(sessionId),
      { store: host.store },
    ),
    scoreAnswers: async ({ sessionId, space, prompt, answers }) => {
      ensureUseRegistered();
      const judgment = host.services.get(JUDGMENT_SERVICE);
      if (!judgment || !space) return [];
      const projection = await host.forSpace(space).sessions.snapshot(sessionId);
      const port: RubricJudgmentPort = {
        resolveUse: (useId) => judgment.resolveUse({ space, projectId: projection.projectId }, useId),
        createRun: (options) => judgment.createRun({ space, projectId: projection.projectId }, options),
      };
      return scoreMultirunAnswers(port, { sessionId, prompt, answers });
    },
  });
  host.services.provide(serverServiceKey<MultirunService>("multirun"), multirun);
  return {
    remoteAccess: localOnlyRemoteAccess(["multirun"]),
    routes: multirunRoutes(multirun),
    onDisable: () => {
      useDisposer?.();
      useDisposer = undefined;
      registeredWith = undefined;
    },
  };
}
