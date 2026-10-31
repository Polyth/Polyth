import { sessionAccessAtLeast, type RouteHandler, type SessionService, type SpaceContext } from "@polyth/contracts";
import { localOnlyRemoteAccess, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import {
  BTW_EVENT_WINDOW,
  buildBtwPrompt,
  buildBtwTranscript,
  parseBtwRequest,
  type BtwResponse,
} from "./index.ts";

const ROUTE = /^\/api\/sessions\/([^/]+)\/btw$/;
const BUSY = new Set(["working", "waiting", "reconciling"]);
export const BTW_TIMEOUT_MS = 90_000;
const BTW_MAX_OUTPUT_TOKENS = 1_500;

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export interface BtwAnswerInput {
  sessionId: string;
  userId: string;
  systemPrompt: string;
  prompt: string;
}

export interface BtwRouteDeps {
  forSpace(space: SpaceContext): { sessions: Pick<SessionService, "snapshot" | "events"> };
  answer(input: BtwAnswerInput): Promise<string>;
}

/** A model failure keeps an actionable code; anything else is a calm 503. */
function modelFailure(error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code) return error as Error;
  const message = error instanceof Error && /timed out/i.test(error.message)
    ? "The model did not answer in time"
    : "The model could not answer right now";
  return fail("unavailable", message);
}

export function btwRoutes(deps: BtwRouteDeps): RouteHandler {
  return async (rc) => {
    const match = ROUTE.exec(rc.path);
    if (!match || rc.method !== "POST") return false;
    let sessionId: string;
    try { sessionId = decodeURIComponent(match[1]!); }
    catch { throw fail("not-found", "Session unavailable"); }
    const sessions = deps.forSpace(rc.space).sessions;
    // Scope comes first: a known-valid foreign-Space id and an absent id get
    // the same answer before the body is read or any history is touched.
    let projection;
    try { projection = await sessions.snapshot(sessionId); }
    catch { throw fail("not-found", "Session unavailable"); }
    if (projection.purpose === "conversation") throw fail("invalid-input", "A conversation between people has no agent to ask about");
    if (projection.sharing && !sessionAccessAtLeast(projection.sharing.access, "collaborate")) {
      throw fail("forbidden", "You can view this chat but not work in it");
    }
    const { question, thread } = parseBtwRequest(await rc.body());
    const events = await sessions.events(sessionId, 0, { limit: BTW_EVENT_WINDOW });
    const transcript = buildBtwTranscript(events);
    const { systemPrompt, prompt } = buildBtwPrompt({
      title: projection.title,
      transcript: transcript.text,
      working: BUSY.has(projection.status),
      thread,
      question,
    });
    let answer: string;
    try {
      answer = (await deps.answer({ sessionId, userId: rc.space.userId, systemPrompt, prompt })).trim();
    } catch (error) {
      throw modelFailure(error);
    }
    if (!answer) throw fail("unavailable", "The model returned an empty answer");
    rc.json(200, { answer } satisfies BtwResponse);
    return true;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  return {
    // Paired devices cannot reach /api/sessions/* package routes (that scope
    // belongs to core), so btw stays local like fusion.
    remoteAccess: localOnlyRemoteAccess(["btw"]),
    routes: btwRoutes({
      forSpace: (space) => host.forSpace(space),
      // The chat's own runtime and model. A direct provider completion is
      // tool-less; a runtime without one answers through a throwaway one-shot
      // session. Neither is the chat's native session nor its history.
      answer: async ({ sessionId, systemPrompt, prompt }) => {
        const { rt, cwd, model } = await host.resolveSessionRuntime(sessionId);
        if (model) {
          const result = await host.smallModelComplete(rt, {
            cwd,
            systemPrompt,
            prompt,
            model,
            maxOutputTokens: BTW_MAX_OUTPUT_TOKENS,
            timeoutMs: BTW_TIMEOUT_MS,
            purpose: "btw",
          });
          return result.text;
        }
        return host.oneShot(rt, { cwd, prompt: `${systemPrompt}\n\n${prompt}`, purpose: "btw", timeoutMs: BTW_TIMEOUT_MS });
      },
    }),
  };
}
