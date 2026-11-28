import type {
  AgentRuntime,
  AvailableProviderDescriptor,
  ModelDescriptor,
  RouteHandler,
  SpaceContext,
} from "@polyth/contracts";
import { allowsInteractiveProviderAuth } from "@polyth/contracts";
import { requireInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";
import { assertInteractiveProviderAuth } from "./providerAuthTarget.ts";
import { PKCE_CALLBACK_PATH } from "./providerPkce.ts";
import type { ProviderAuthController } from "./providerAuth.ts";

interface VisibilityService {
  catalog(models: ModelDescriptor[], userId?: string): Array<{ id: string; connected: boolean }>;
  available(
    models: ModelDescriptor[],
    live: readonly AvailableProviderDescriptor[],
    authMethodIds: readonly string[],
    userId?: string,
  ): AvailableProviderDescriptor[];
}

const optionalStringRecord = (value: unknown, label: string): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error(`${label} must be an object of strings`), { code: "invalid-input" });
  }
  const entries = Object.entries(value);
  if (entries.some(([key, item]) => !key || typeof item !== "string")) {
    throw Object.assign(new Error(`${label} must be an object of strings`), { code: "invalid-input" });
  }
  return Object.fromEntries(entries);
};

const optionalProviderCall = <T>(
  call: (() => Promise<T>) | undefined,
  fallback: T,
): Promise<T> => call
  ? call().catch((error: unknown) => {
      const code = (error as { code?: unknown }).code;
      if (code === "unsupported" || code === "capability-unsupported") return fallback;
      throw error;
    })
  : Promise.resolve(fallback);

export function providerAuthRoutes(deps: {
  auth: ProviderAuthController;
  runtime(space: SpaceContext): Promise<AgentRuntime>;
  visibility?: VisibilityService;
}): RouteHandler {
  const connectedIds = async (rt: AgentRuntime): Promise<Set<string>> => {
    try {
      const models = await rt.models();
      return new Set(
        models.filter((model) => model.connected !== false).map((model) => model.providerID),
      );
    } catch {
      return new Set();
    }
  };

  return async (request) => {
    const { path } = request;
    if (!path.startsWith("/api/providers")) return false;
    const { method, json, body, space } = request;

    // Vendor redirect target for first-party PKCE sign-in. It is a plain GET
    // from the user's own browser, so it answers with a small HTML page. The
    // code is single-use and useless without the server-held verifier; the
    // state is the only lookup key, and it belongs to one attempt and Space.
    if (path === PKCE_CALLBACK_PATH && method === "GET") {
      // Writing a provider credential is owner-only, and this GET writes one.
      // A member's navigation fails closed here; the callback URL still carries
      // the code back to the owner's own paste field.
      requireInstanceOwnerAuthority(request, "provider credential changes require the instance owner");
      assertInteractiveProviderAuth(space);
      const state = request.url.searchParams.get("state") ?? "";
      const code = request.url.searchParams.get("code") ?? undefined;
      const denied = request.url.searchParams.get("error") ?? undefined;
      const page = (status: number, title: string, detail: string): void => {
        const escape = (value: string) => value
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
        request.res.writeHead(status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        request.res.end(
          "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
          + `<title>${escape(title)}</title>`
          + "<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;max-width:40rem;margin-inline:auto}"
          + "h1{font-size:1.25rem}code{background:#8882;padding:.1em .35em;border-radius:.3em}</style>"
          + `<h1>${escape(title)}</h1><p>${escape(detail)}</p>`,
        );
      };
      if (denied) {
        page(200, "Authorization declined", "Nothing was connected. You can close this tab and return to Polyth.");
        return true;
      }
      if (!state || !code) {
        page(400, "Missing authorization details", "Open this flow again from Polyth → Providers & Models.");
        return true;
      }
      try {
        const attempt = await deps.auth.completePkceCallback(state, code, space);
        page(
          200,
          attempt.phase === "configured_unverified" || attempt.phase === "connected" ? "Connected" : "Almost done",
          attempt.phase === "configured_unverified" || attempt.phase === "connected"
            ? "Polyth received a key for " + attempt.providerId + ". You can close this tab."
            : "Polyth could not finish the exchange. Return to the tab where you started the sign-in.",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        page(200, "Could not finish sign-in", message + " — return to Polyth and paste the callback URL there.");
      }
      return true;
    }
    const runtime = () => deps.runtime(space);
    const requireGlobalMutation = () => requireInstanceOwnerAuthority(
      request,
      "provider credential changes require the instance owner",
    );

    if (path === "/api/providers/available" && method === "GET") {
      if (!deps.visibility) return false;
      const rt = await runtime();
      const [live, authCaps, openCodeModels] = await Promise.all([
        optionalProviderCall(rt.listAllProviders ? () => rt.listAllProviders!() : undefined, []),
        deps.auth.capabilities(new Set(), space).catch(() => ({ providers: {} as Record<string, unknown> })),
        rt.models().catch((): ModelDescriptor[] => []),
      ]);
      // The candidate list must exclude what THIS account already shows; a
      // host-global view would offer another person's hidden provider again.
      // "Shown" means shown on OpenCode's page, so only OpenCode's own models
      // count: Pi's connected opencode-go models must not hide OpenCode Go.
      json(200, deps.visibility.available(openCodeModels, live, Object.keys(authCaps.providers), space.userId));
      return true;
    }
    if (path === "/api/providers/auth-capabilities" && method === "GET") {
      const connected = allowsInteractiveProviderAuth(space.deployment)
        ? await connectedIds(await runtime())
        : new Set<string>();
      json(200, await deps.auth.capabilities(connected, space));
      return true;
    }
    if (path === "/api/providers/auth/well-known/preview" && method === "POST") {
      assertInteractiveProviderAuth(space);
      const input = await body();
      if (typeof input.origin !== "string" || !input.origin.trim()) {
        throw Object.assign(new Error("origin is required"), { code: "AUTH_INPUT_INVALID", field: "origin" });
      }
      json(200, await deps.auth.previewWellKnown(input.origin, space));
      return true;
    }
    if (path === "/api/providers/auth/well-known/execute" && method === "POST") {
      requireGlobalMutation();
      assertInteractiveProviderAuth(space);
      const input = await body();
      if (typeof input.origin !== "string" || typeof input.hash !== "string" || input.confirm !== true) {
        throw Object.assign(new Error("reviewed origin, hash, and confirm=true are required"), { code: "AUTH_INPUT_INVALID" });
      }
      json(200, await deps.auth.executeWellKnown(input.origin, input.hash, space));
      return true;
    }

    let match = path.match(/^\/api\/providers\/auth\/attempts\/([^/]+)$/);
    if (match && method === "GET") {
      const attempt = deps.auth.getAttempt(decodeURIComponent(match[1]!), space);
      if (!attempt) throw Object.assign(new Error("Sign-in attempt was not found."), { code: "AUTH_SESSION_STALE" });
      json(200, attempt);
      return true;
    }
    if (match && method === "DELETE") {
      requireGlobalMutation();
      assertInteractiveProviderAuth(space);
      json(200, deps.auth.cancelAttempt(decodeURIComponent(match[1]!), space));
      return true;
    }
    match = path.match(/^\/api\/providers\/auth\/attempts\/([^/]+)\/complete$/);
    if (match && method === "POST") {
      requireGlobalMutation();
      assertInteractiveProviderAuth(space);
      const input = await body();
      const code = typeof input.code === "string" ? input.code : undefined;
      if (code !== undefined && !code.trim()) {
        throw Object.assign(new Error("code must be a non-empty string"), { code: "AUTH_INPUT_INVALID", field: "code" });
      }
      json(200, await deps.auth.completeAttempt(decodeURIComponent(match[1]!), code, space));
      return true;
    }

    match = path.match(/^\/api\/providers\/([^/]+)\/auth$/);
    if (match && method === "GET") {
      const providerId = decodeURIComponent(match[1]!);
      const connected = allowsInteractiveProviderAuth(space.deployment)
        ? (await connectedIds(await runtime())).has(providerId)
        : false;
      json(200, await deps.auth.view(providerId, connected, space));
      return true;
    }
    match = path.match(/^\/api\/providers\/([^/]+)\/auth\/attempts$/);
    if (match && method === "POST") {
      requireGlobalMutation();
      assertInteractiveProviderAuth(space);
      const providerId = decodeURIComponent(match[1]!);
      const input = await body();
      if (typeof input.methodId !== "string" || !input.methodId) {
        throw Object.assign(new Error("methodId is required"), { code: "AUTH_INPUT_INVALID", field: "methodId" });
      }
      json(200, await deps.auth.startAttempt({
        providerId,
        methodId: input.methodId,
        inputs: optionalStringRecord(input.inputs, "inputs"),
        ...(typeof input.revision === "string" && input.revision ? { revision: input.revision } : {}),
        browserLocality: "unknown",
        space,
      }));
      return true;
    }
    match = path.match(/^\/api\/providers\/([^/]+)\/disconnect$/);
    if (match && method === "POST") {
      requireGlobalMutation();
      assertInteractiveProviderAuth(space);
      json(200, await deps.auth.disconnect(decodeURIComponent(match[1]!), space));
      return true;
    }
    return false;
  };
}
