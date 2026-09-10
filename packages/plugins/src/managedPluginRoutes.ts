import type { RouteHandler } from "@polyth/contracts";
import type { PluginRegistry } from "./managedRegistry.ts";
import type { ServerPackageHost } from "./serverPackage.ts";
import { invokePackageRpc } from "./packageRpc.ts";
import { assertApprovedConnection, completeOauthFromTx, setTokenConnection, startOauth } from "./connections.ts";
import { connectionFingerprint } from "./connectionFingerprint.ts";
import { assertAuthConnectionGranted } from "./grants.ts";
import {
  assertDeploymentPackageMutator,
  assertSpacePackageDisable,
  assertSpacePackageEnable,
  assertSpacePackageGrant,
} from "./lifecycleAuth.ts";
import { assertOauthTxMatchesActive, consumeOauthTx, oauthRedirectOrigin } from "./oauthTx.ts";
import { notFound, secretVault } from "./pluginRouteShared.ts";

export function managedPluginRoutes(
  registry: PluginRegistry,
  host: ServerPackageHost,
): RouteHandler {
  return async (request) => {
    const { path, method } = request;
    if (path !== "/api/plugins" && !path.startsWith("/api/plugins/")) return false;
    const storage = host.spaceStorage(request.space);
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
    let match = path.match(/^\/api\/plugins\/([^/]+)\/(reload|enable|disable|update|rollback|grants|rpc)$/);
    if (match && method === "POST") {
      const id = decodeURIComponent(match[1]!);
      const operation = match[2]!;
      if (operation === "enable") {
        assertSpacePackageEnable(request, request.space);
        request.json(200, await registry.enable(id, storage));
      } else if (operation === "disable") {
        assertSpacePackageDisable(request, request.space);
        request.json(200, await registry.disable(id, storage));
      } else if (operation === "reload") {
        assertDeploymentPackageMutator(request);
        request.json(200, await registry.reload(id));
      } else if (operation === "update") {
        assertDeploymentPackageMutator(request);
        request.json(200, await registry.update(id, { storage }));
      } else if (operation === "rollback") {
        assertDeploymentPackageMutator(request);
        const input = await request.body();
        request.json(200, await registry.rollback(
          id,
          typeof input.version === "string" ? input.version : undefined,
          storage,
        ));
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
        request.json(200, await registry.grant(
          id,
          capabilityNames,
          storage,
          request.space.userId,
          connectionIds,
        ));
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
        if (projectId) {
          const project = await host.projects.get(projectId);
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
      request.json(200, { ok: await registry.remove(decodeURIComponent(match[1]!), storage) });
      return true;
    }
    return false;
  };
}
