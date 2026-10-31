// Voice mode is a browser experience: it records through the dictation
// package's routes, speaks through its TTS proxy and sends turns through the
// conversation's own composer. Its own routes are the small-model narrator
// (`narrateRoutes.ts`): a status read and one rate-limited remark per call.
// A paired phone, the main voice device, may use both with the same
// `dictation.use` grant it already has for its voice; everything else under
// /api/voice-mode stays default-deny.
import { localOnlyRemoteAccess, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import {
  NARRATE_MAX_OUTPUT_TOKENS,
  NARRATE_PATH,
  NARRATE_TIMEOUT_MS,
  NARRATION_STATUS_PATH,
  narrateRoutes,
} from "./narrateRoutes.ts";

export const VOICE_MODE_REMOTE_ACCESS = {
  ...localOnlyRemoteAccess(["voice-mode"]),
  http: [
    { methods: ["GET"] as const, path: NARRATION_STATUS_PATH, capability: "dictation.use", mutation: false },
    // A mutation: each call spends the account's small-model budget.
    { methods: ["POST"] as const, path: NARRATE_PATH, capability: "dictation.use", mutation: true, maxBodyBytes: 512 },
  ],
};

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let routes: ReturnType<typeof narrateRoutes> | null = null;
  return {
    remoteAccess: VOICE_MODE_REMOTE_ACCESS,
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      routes = narrateRoutes({
        forSpace: (space) => host.forSpace(space),
        smallModel: (userId) => {
          const model = host.smallModel(userId);
          return model ? { label: model.modelID } : undefined;
        },
        // Only the account's small model, and only its tool-less direct
        // completion: the digest is untrusted session content.
        complete: async ({ userId, systemPrompt, prompt, signal }) => {
          const model = host.smallModel(userId);
          if (!model) throw Object.assign(new Error("No small model is configured"), { code: "unsupported" });
          const runtime = await host.runtimes.forProject("__default__", undefined, model.harnessId);
          const result = await host.smallModelComplete(runtime, {
            cwd: process.cwd(),
            systemPrompt,
            prompt,
            model,
            maxOutputTokens: NARRATE_MAX_OUTPUT_TOKENS,
            timeoutMs: NARRATE_TIMEOUT_MS,
            signal,
            purpose: "voice-narration",
            requireDirect: true,
          });
          return result.text;
        },
        now: () => Date.now(),
      });
    },
    onDisable() {
      routes?.dispose();
      routes = null;
    },
  };
}
