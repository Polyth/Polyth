// Streaming dictation REST (WP15). Audio itself travels over /ws
// (dictation/audio messages); these routes own the session lifecycle.
// Nothing here appends to the session event log: raw audio and interim
// transcripts are transient by design.
import type { DictationService } from "@polyth/dictation";
import type { RouteHandler } from "../http.ts";

const STATUS: Record<string, number> = {
  "not-found": 404,
  "invalid-input": 400,
  unavailable: 503,
  limit: 429,
  conflict: 409,
  gap: 409,
  "out-of-order": 409,
  "too-long": 413,
};

export function dictationRoutes(deps: { dictation: DictationService }): RouteHandler {
  const { dictation } = deps;
  return async ({ path, method, body, json }) => {
    try {
      if (path === "/api/dictation/capability" && method === "GET") {
        json(200, dictation.capability());
        return true;
      }
      if (path === "/api/dictation" && method === "POST") {
        const b = await body();
        const dto = dictation.create({
          ...(b.sessionId ? { sessionId: String(b.sessionId) } : {}),
          ...(b.language ? { language: String(b.language) } : {}),
        });
        json(200, dto);
        return true;
      }
      let m = path.match(/^\/api\/dictation\/([^/]+)$/);
      if (m && m[1] !== "capability" && method === "GET") {
        const dto = dictation.get(m[1]!);
        json(dto ? 200 : 404, dto ?? { error: "not-found" });
        return true;
      }
      if (m && method === "DELETE") {
        dictation.cancel(m[1]!);
        json(200, { ok: true });
        return true;
      }
      m = path.match(/^\/api\/dictation\/([^/]+)\/finalize$/);
      if (m && method === "POST") {
        json(200, await dictation.finalize(m[1]!));
        return true;
      }
      return false;
    } catch (err) {
      const e = err as Error & { code?: string };
      json(STATUS[e.code ?? ""] ?? 500, { error: e.code ?? "internal", message: e.message });
      return true;
    }
  };
}
