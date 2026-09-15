import type { JsonObject, RouteHandler, SessionEvent } from "@polyth/contracts";
import type {
  ContributionInvocation,
  ContributionInvocationKind,
  PackageJsonObject,
} from "@polyth/package-sdk";
import type { PackageManifest, PackageManifestV2 } from "@polyth/package-sdk/manifest";
import type { PluginRegistry } from "./managedRegistry.ts";
import type { ServerPackageHost } from "./serverPackage.ts";
import { invokePackageRpc } from "./packageRpc.ts";
import { createInvocationLeaseStore } from "./invocationLeases.ts";
import {
  assertApprovedConnection,
  completeOauthFromTx,
  retireConnectionIds,
  setTokenConnection,
  startOauth,
} from "./connections.ts";
import { connectionFingerprint } from "./connectionFingerprint.ts";
import { assertAuthConnectionGranted, retireConnectionApprovals } from "./grants.ts";
import {
  assertDeploymentPackageMutator,
  assertSpacePackageDisable,
  assertSpacePackageEnable,
  assertSpacePackageGrant,
} from "./lifecycleAuth.ts";
import { assertOauthTxMatchesActive, consumeOauthTx, oauthRedirectOrigin } from "./oauthTx.ts";
import { notFound, secretVault } from "./pluginRouteShared.ts";

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

const invocationKinds = new Set<ContributionInvocationKind>([
  "composer-action",
  "attachment-provider",
  "message-action",
  "session-action",
  "command",
  "tool-renderer",
  "status-badge",
  "settings-section",
  "context-provider",
  "widget",
  "surface",
]);

function packageGeneration(registry: PluginRegistry, id: string): string {
  const active = registry.activeIdentity(id);
  return `${active.installGeneration}:${active.version}:${active.integrity}`;
}

function contributionOf(manifest: PackageManifest, kind: ContributionInvocationKind, id: string): Record<string, unknown> | null {
  const contributes = manifest.contributes;
  const find = (items: readonly { id: string }[] | undefined): Record<string, unknown> | null =>
    (items?.find((item) => item.id === id) as unknown as Record<string, unknown> | undefined) ?? null;
  if (kind === "surface") return find(contributes?.surfaces);
  if (kind === "composer-action") return find(contributes?.composerActions);
  if (manifest.manifestVersion !== 2) return null;
  const v2 = (manifest as PackageManifestV2).contributes;
  if (kind === "attachment-provider") return find(v2?.attachmentProviders);
  if (kind === "message-action") return find(v2?.messageActions);
  if (kind === "session-action") return find(v2?.sessionActions);
  if (kind === "command") return find(v2?.commands);
  if (kind === "tool-renderer") return find(v2?.toolRenderers);
  if (kind === "status-badge") return find(v2?.statusBadges);
  if (kind === "settings-section") return find(v2?.settingsSections);
  if (kind === "context-provider") return find(v2?.contextProviders);
  if (kind === "widget") return find(v2?.widgets);
  return null;
}

function boundedObject(value: unknown, maxBytes = 16 * 1024): PackageJsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > maxBytes) fail("invalid-input", "extension invocation data is too large");
  return JSON.parse(text) as PackageJsonObject;
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

async function canonicalEvent(host: ServerPackageHost, sessionId: string, rawSeq: unknown): Promise<SessionEvent> {
  const seq = Number(rawSeq);
  if (!Number.isSafeInteger(seq) || seq < 1) fail("invalid-input", "canonical event sequence is required");
  const events = await host.sessions.events(sessionId, seq - 1, { beforeSeq: seq + 1, limit: 2 });
  const event = events.find((item) => item.seq === seq);
  if (!event) throw notFound("message or tool target no longer exists");
  return event;
}

function canonicalMessage(event: SessionEvent): {
  id: string;
  role: "user" | "assistant" | "tool";
  text?: string;
  toolName?: string;
} {
  const data = event.data as Record<string, unknown>;
  if (event.type === "user/message") {
    return {
      id: event.id,
      role: "user",
      ...(typeof data.text === "string" ? { text: data.text.slice(0, 24_000) } : {}),
    };
  }
  if (event.type === "assistant/message") {
    return {
      id: event.id,
      role: "assistant",
      ...(typeof data.text === "string" ? { text: data.text.slice(0, 24_000) } : {}),
    };
  }
  if (event.type === "tool/result") {
    return {
      id: event.id,
      role: "tool",
      ...(typeof data.output === "string" ? { text: data.output.slice(0, 24_000) } : {}),
      ...(typeof data.tool === "string" ? { toolName: data.tool.slice(0, 160) } : {}),
    };
  }
  if (event.type === "tool/error") {
    return {
      id: event.id,
      role: "tool",
      ...(typeof data.error === "string" ? { text: data.error.slice(0, 24_000) } : {}),
      ...(typeof data.tool === "string" ? { toolName: data.tool.slice(0, 160) } : {}),
    };
  }
  fail("invalid-input", "selected event is not a message action target");
}

function canonicalTool(event: SessionEvent): {
  callId: string;
  name: string;
  input?: PackageJsonObject;
  output?: unknown;
  error?: string;
} {
  if (event.type !== "tool/call" && event.type !== "tool/result" && event.type !== "tool/error") {
    fail("invalid-input", "selected event is not a tool renderer target");
  }
  const data = event.data as Record<string, unknown>;
  const callId = boundedString(data.callId, 240);
  const name = boundedString(data.tool, 240);
  if (!callId || !name) fail("invalid-input", "canonical tool target is incomplete");
  const input = boundedObject(data.input, 16 * 1024);
  const output = event.type === "tool/result" && data.output !== undefined
    ? JSON.parse(JSON.stringify(data.output))
    : undefined;
  return {
    callId,
    name,
    ...(input ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(event.type === "tool/error" && typeof data.error === "string"
      ? { error: data.error.slice(0, 8_000) }
      : {}),
  };
}

async function buildInvocation(input: {
  manifest: PackageManifest;
  kind: ContributionInvocationKind;
  contributionId: string;
  body: Record<string, unknown>;
  sessionId?: string;
  projectId?: string;
  host: ServerPackageHost;
}): Promise<Omit<ContributionInvocation, "invocationId" | "lease" | "expiresAt" | "spaceId">> {
  const contribution = contributionOf(input.manifest, input.kind, input.contributionId);
  if (!contribution) fail("not-found", "extension contribution is not declared");
  const base = {
    kind: input.kind,
    contributionId: input.contributionId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  } as const;
  const data = input.body.data && typeof input.body.data === "object" && !Array.isArray(input.body.data)
    ? input.body.data as Record<string, unknown>
    : {};

  if (input.kind === "message-action") {
    if (!input.sessionId) fail("invalid-input", "message action requires a session");
    const event = await canonicalEvent(input.host, input.sessionId, data.eventSeq);
    const message = canonicalMessage(event);
    const roles = Array.isArray(contribution.roles) ? contribution.roles : [];
    if (roles.length && !roles.includes(message.role)) fail("invalid-input", "message role is not accepted by this action");
    return { ...base, kind: "message-action", message };
  }

  if (input.kind === "session-action") {
    if (!input.sessionId) fail("invalid-input", "session action requires a session");
    const session = await input.host.sessions.snapshot(input.sessionId);
    return {
      ...base,
      kind: "session-action",
      session: {
        id: session.id,
        title: session.title.slice(0, 240),
        status: session.status,
      },
    };
  }

  if (input.kind === "command") {
    return {
      ...base,
      kind: "command",
      query: boundedString(data.query, 1_000),
      arguments: boundedString(data.arguments, 4_000),
    };
  }

  if (input.kind === "tool-renderer") {
    if (!input.sessionId) fail("invalid-input", "tool renderer requires a session");
    const event = await canonicalEvent(input.host, input.sessionId, data.eventSeq);
    const tool = canonicalTool(event);
    const matcher = contribution.matcher && typeof contribution.matcher === "object"
      ? contribution.matcher as Record<string, unknown>
      : {};
    const tools = Array.isArray(matcher.tools) ? matcher.tools.filter((item): item is string => typeof item === "string") : [];
    const prefix = typeof matcher.prefix === "string" ? matcher.prefix : "";
    if ((tools.length || prefix) && !tools.includes(tool.name) && !(prefix && tool.name.startsWith(prefix))) {
      fail("invalid-input", "tool renderer does not match this tool");
    }
    return { ...base, kind: "tool-renderer", tool };
  }

  if (input.kind === "attachment-provider" || input.kind === "context-provider") {
    return {
      ...base,
      kind: input.kind,
      ...(typeof data.query === "string" ? { query: data.query.slice(0, 1_000) } : {}),
    };
  }

  return {
    ...base,
    kind: input.kind as "composer-action" | "settings-section" | "status-badge" | "widget" | "surface",
    ...(boundedObject(data.input) ? { input: boundedObject(data.input) } : {}),
  };
}

export function managedPluginRoutes(
  registry: PluginRegistry,
  host: ServerPackageHost,
): RouteHandler {
  const invocationLeases = createInvocationLeaseStore();
  return async (request) => {
    const { path, method } = request;
    if (path !== "/api/plugins" && !path.startsWith("/api/plugins/")) return false;
    const storage = host.spaceStorage(request.space);
    const retireRemovedConnections = async <T>(id: string, mutation: () => Promise<T>): Promise<T> => {
      const before = new Set((registry.canonicalManifest(id).connections ?? []).map((spec) => spec.id));
      const result = await mutation();
      const after = new Set((registry.canonicalManifest(id).connections ?? []).map((spec) => spec.id));
      const removed = [...before].filter((connectionId) => !after.has(connectionId));
      if (removed.length === 0) return result;
      const spaces = host.packageSpaces?.() ?? [{ spaceId: request.space.spaceId, storage }];
      const vault = secretVault(host);
      for (const space of spaces) {
        retireConnectionApprovals(space.storage, id, removed);
        await retireConnectionIds(vault, space.storage, id, space.spaceId, removed);
      }
      return result;
    };

    if (path === "/api/plugins" && method === "GET") {
      request.json(200, registry.list(storage));
      return true;
    }
    if (path === "/api/plugins/install" && method === "POST") {
      assertDeploymentPackageMutator(request);
      const input = await request.body();
      request.json(200, await registry.install(String(input.source ?? "")));
      return true;
    }
    if (path === "/api/plugins/oauth/callback" && method === "GET") {
      const state = request.url.searchParams.get("state") ?? "";
      const code = request.url.searchParams.get("code") ?? "";
      if (!storage || !state || !code) {
        throw Object.assign(new Error("oauth callback is invalid"), { code: "invalid-input" });
      }
      const tx = consumeOauthTx({ oauthTxId: state, spaceId: request.space.spaceId });
      let identity;
      try {
        identity = registry.activeIdentity(tx.packageId);
      } catch {
        throw Object.assign(new Error("oauth retry required; package changed during authorization"), {
          code: "invalid-input",
        });
      }
      const manifest = registry.canonicalManifest(tx.packageId);
      const spec = (manifest.connections ?? []).find((item) => item.id === tx.connectionId);
      if (!spec || spec.kind !== "oauth" || !spec.oauth) throw notFound("connection is not declared");
      assertOauthTxMatchesActive(tx, {
        packageId: tx.packageId,
        version: identity.version,
        integrity: identity.integrity,
        installGeneration: identity.installGeneration,
        connectionId: spec.id,
        connectionFingerprint: connectionFingerprint(spec),
      });
      assertApprovedConnection(storage, tx.packageId, spec);
      await completeOauthFromTx({
        storage,
        spaceId: request.space.spaceId,
        vault: secretVault(host),
      }, spec, tx, code);
      request.res.writeHead(302, { location: "/?settings=plugins" });
      request.res.end();
      return true;
    }

    let match = path.match(/^\/api\/plugins\/([^/]+)\/invocations$/);
    if (match && method === "POST") {
      const id = decodeURIComponent(match[1]!);
      if (!storage || !registry.isEnabled(id, storage)) fail("PACKAGE_DISABLED", "package is disabled");
      const manifest = registry.canonicalManifest(id);
      if (manifest.runtime?.kind !== "sandboxed") fail("invalid-input", "host-scoped invocations are for sandboxed packages");
      const requestBody = await request.body();
      const kind = typeof requestBody.kind === "string" && invocationKinds.has(requestBody.kind as ContributionInvocationKind)
        ? requestBody.kind as ContributionInvocationKind
        : fail("invalid-input", "contribution kind is invalid");
      const contributionId = boundedString(requestBody.contributionId, 64);
      if (!contributionId) fail("invalid-input", "contribution id is required");
      const sessionId = typeof requestBody.sessionId === "string" ? requestBody.sessionId : undefined;
      const projectId = typeof requestBody.projectId === "string" ? requestBody.projectId : undefined;
      if (sessionId) {
        let snap;
        try { snap = await host.sessions.snapshot(sessionId); } catch { throw notFound("session not found"); }
        if (snap.spaceId !== request.space.spaceId) throw notFound("session not found");
      }
      if (projectId) {
        const project = await host.projects.get(projectId);
        if (!project || project.spaceId !== request.space.spaceId) throw notFound("project not found");
      }
      const invocation = await buildInvocation({
        manifest,
        kind,
        contributionId,
        body: requestBody,
        sessionId,
        projectId,
        host,
      });
      request.json(200, invocationLeases.issue({
        packageId: id,
        spaceId: request.space.spaceId,
        generation: packageGeneration(registry, id),
      }, invocation));
      return true;
    }

    match = path.match(/^\/api\/plugins\/([^/]+)\/(reload|enable|disable|update|rollback|grants|rpc)$/);
    if (match && method === "POST") {
      const id = decodeURIComponent(match[1]!);
      const operation = match[2]!;
      if (operation === "enable") {
        assertSpacePackageEnable(request, request.space);
        request.json(200, await registry.enable(id, storage));
      } else if (operation === "disable") {
        assertSpacePackageDisable(request, request.space);
        invocationLeases.revokePackage(id);
        request.json(200, await registry.disable(id, storage));
      } else if (operation === "reload") {
        assertDeploymentPackageMutator(request);
        invocationLeases.revokePackage(id);
        request.json(200, await registry.reload(id));
      } else if (operation === "update") {
        assertDeploymentPackageMutator(request);
        invocationLeases.revokePackage(id);
        request.json(200, await retireRemovedConnections(id, () => registry.update(id, { storage })));
      } else if (operation === "rollback") {
        assertDeploymentPackageMutator(request);
        invocationLeases.revokePackage(id);
        const input = await request.body();
        request.json(200, await retireRemovedConnections(id, () => registry.rollback(
          id,
          typeof input.version === "string" ? input.version : undefined,
          storage,
        )));
      } else if (operation === "grants") {
        assertSpacePackageGrant(request, request.space);
        if (!storage) throw Object.assign(new Error("space storage required"), { code: "invalid-input" });
        const input = await request.body();
        const capabilityNames = Array.isArray(input.capabilities)
          ? (input.capabilities as unknown[])
            .filter((item): item is string => typeof item === "string" && item.length > 0)
          : [];
        const connectionIds = Array.isArray(input.connections)
          ? (input.connections as unknown[])
            .filter((item): item is string => typeof item === "string" && item.length > 0)
          : [];
        request.json(200, await retireRemovedConnections(id, () => registry.grant(
          id,
          capabilityNames,
          storage,
          request.space.userId,
          connectionIds,
        )));
      } else if (operation === "rpc") {
        if (!host || !storage) throw Object.assign(new Error("space storage required"), { code: "invalid-input" });
        const input = await request.body();
        const methodName = String(input.method ?? "");
        const sessionId = typeof input.sessionId === "string" ? input.sessionId : undefined;
        const projectId = typeof input.projectId === "string" ? input.projectId : undefined;
        if (sessionId) {
          let snap;
          try {
            snap = await host.sessions.snapshot(sessionId);
          } catch {
            throw notFound("session not found");
          }
          if (snap.spaceId !== request.space.spaceId) throw notFound("session not found");
        }
        let project;
        if (projectId) {
          project = await host.projects.get(projectId);
          if (!project || project.spaceId !== request.space.spaceId) throw notFound("project not found");
        }
        try {
          const result = await invokePackageRpc({
            space: request.space,
            storage,
            sessions: host.sessions,
            projects: host.projects,
            appendEvent: (sid, type, data) => host.events.append(sid, type, data, {
              producerPlugin: id,
            }),
            manifest: registry.canonicalManifest(id),
            enabled: registry.isEnabled(id, storage),
            sessionId,
            projectId,
            log: (line) => registry.log(id, line),
            secrets: secretVault(host),
            invocationLeases,
            invocationIdentity: {
              packageId: id,
              spaceId: request.space.spaceId,
              generation: packageGeneration(registry, id),
            },
            ...(project ? {
              generateModel: async ({ prompt, maxOutputTokens, timeoutMs }) => {
                const model = host.smallModel(request.space.userId);
                if (!model) fail("HOST_UNAVAILABLE", "utility model is not configured");
                const runtime = await host.runtimes.forProject(project.id, project.path, model.harnessId);
                const result = await host.smallModelComplete(runtime, {
                  cwd: project.path,
                  prompt,
                  model,
                  maxOutputTokens,
                  timeoutMs,
                  purpose: "extension-utility",
                });
                return {
                  text: result.text,
                  modelClass: "utility" as const,
                  inputTruncated: result.inputTruncated,
                };
              },
            } : {}),
          }, methodName, input.payload);
          request.json(200, { ok: true, payload: result });
        } catch (cause) {
          const error = cause as Error & { code?: string };
          request.json(200, {
            ok: false,
            error: { code: error.code ?? "HOST_REJECTED", message: error.message },
          });
        }
      }
      return true;
    }
    match = path.match(/^\/api\/plugins\/([^/]+)\/connections\/([^/]+)(\/oauth)?$/);
    if (match && method === "POST") {
      const id = decodeURIComponent(match[1]!);
      const connectionId = decodeURIComponent(match[2]!);
      if (!host || !storage) throw Object.assign(new Error("space storage required"), { code: "invalid-input" });
      const manifest = registry.canonicalManifest(id);
      const spec = (manifest.connections ?? []).find((item) => item.id === connectionId);
      if (!spec) throw notFound("connection is not declared");
      assertAuthConnectionGranted(storage, id, manifest.capabilities ?? []);
      assertApprovedConnection(storage, id, spec);
      const scope = {
        storage,
        spaceId: request.space.spaceId,
        vault: secretVault(host),
      };
      if (match[3] === "/oauth") {
        if (spec.kind !== "oauth") {
          throw Object.assign(new Error("connection is not oauth"), { code: "invalid-input" });
        }
        const origin = oauthRedirectOrigin({
          hostHeader: request.req.headers.host,
          configured: process.env.POLYTH_PUBLIC_ORIGIN,
        });
        const redirectUri = `${origin}/api/plugins/oauth/callback`;
        const identity = registry.activeIdentity(id);
        const started = startOauth(scope, id, spec, {
          redirectUri,
          version: identity.version,
          integrity: identity.integrity,
          installGeneration: identity.installGeneration,
        });
        request.json(200, { id: spec.id, label: spec.label, kind: spec.kind, status: "connecting", url: started.url });
        return true;
      }
      const input = await request.body();
      const token = typeof input.token === "string" ? input.token : "";
      request.json(200, await setTokenConnection(scope, id, spec, token));
      return true;
    }
    match = path.match(/^\/api\/plugins\/([^/]+)\/logs$/);
    if (match && method === "GET") {
      request.json(200, registry.logs(decodeURIComponent(match[1]!), {
        after: Number(request.url.searchParams.get("after") ?? 0),
        limit: Number(request.url.searchParams.get("limit") ?? 200),
      }));
      return true;
    }
    match = path.match(/^\/api\/plugins\/([^/]+)$/);
    if (match && method === "DELETE") {
      assertDeploymentPackageMutator(request);
      const id = decodeURIComponent(match[1]!);
      invocationLeases.revokePackage(id);
      request.json(200, { ok: await registry.remove(id, storage) });
      return true;
    }
    return false;
  };
}
