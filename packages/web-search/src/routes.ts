import type { RouteHandler } from "@polyth/contracts";
import { roleAtLeast } from "@polyth/contracts";
import { webSearchError, webSearchErrorCode, type WebSearchErrorCode } from "./errors.ts";
import type { WebSearchRuntime } from "./runtime.ts";

export interface WebSearchRouteRuntime {
  settingsSnapshot: WebSearchRuntime["settingsSnapshot"];
  saveSettings: WebSearchRuntime["saveSettings"];
}

const statusFor = (cause: unknown): number => {
  switch (webSearchErrorCode(cause)) {
    case "invalid-input": return 400;
    case "forbidden": return 403;
    case "conflict": return 409;
    case "auth-required": return 503;
    case "unavailable":
    case "provider-unavailable": return 503;
    default: return 500;
  }
};

const PUBLIC_ERROR_CODES = new Set<WebSearchErrorCode>([
  "invalid-input",
  "conflict",
  "forbidden",
  "auth-required",
  "unavailable",
]);

const publicCode = (cause: unknown): WebSearchErrorCode =>
  (() => {
    const code = webSearchErrorCode(cause);
    return code && PUBLIC_ERROR_CODES.has(code) ? code : "unavailable";
  })();

const safeMessage = (cause: unknown, fallback: string): string => {
  const code = publicCode(cause);
  if (PUBLIC_ERROR_CODES.has(code) && code !== "unavailable" && cause instanceof Error) return cause.message;
  return fallback;
};

export function webSearchRoutes(runtime: WebSearchRouteRuntime): RouteHandler {
  return async ({ path, method, body, json, space }) => {
    if (path !== "/api/web-search/settings") return false;
    if (method === "GET") {
      try {
        json(200, runtime.settingsSnapshot(space));
      } catch (cause) {
        json(statusFor(cause), { error: publicCode(cause), message: safeMessage(cause, "Web search settings are unavailable") });
      }
      return true;
    }
    if (method === "PUT") {
      try {
        // Search settings (provider, credential handle) apply to the whole Space.
        if (!roleAtLeast(space.role, "admin")) {
          throw webSearchError("forbidden", "Only Space admins can change web search settings");
        }
        const input = await body();
        const record = input && typeof input === "object" && !Array.isArray(input)
          ? input as Record<string, unknown>
          : {};
        json(200, runtime.saveSettings(space, record.settings, record.expectedRevision));
      } catch (cause) {
        json(statusFor(cause), { error: publicCode(cause), message: safeMessage(cause, "Web search settings could not be saved") });
      }
      return true;
    }
    return false;
  };
}
