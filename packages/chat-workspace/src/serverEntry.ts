import type {
  ChatWorkspaceSettingsDto,
  JsonObject,
  RemoteAccessPolicy,
  RouteHandler,
} from "@polyth/contracts";
import type { ProfileRegistry } from "@polyth/browser";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createChatWorkspaceFrameBus } from "./frameBus.ts";
import { createChatWorkspaceService } from "./service.ts";
import { err, loadSettings } from "./storage.ts";

const STATUS: Record<string, number> = {
  "not-found": 404,
  "invalid-input": 400,
  unavailable: 503,
  forbidden: 403,
  "profile-locked": 409,
};

const VIEWPORT_MIN = { width: 320, height: 240 };
const VIEWPORT_MAX = { width: 4096, height: 4096 };
const VIEWPORT_DEFAULT = { width: 1280, height: 800 };

/** Client-supplied viewport sizes drive a real Chromium page, so they are
 *  clamped to a sane range instead of trusted (NaN/0/huge → bounded ints). */
export function clampViewport(width: unknown, height: unknown): { width: number; height: number } {
  const clamp = (raw: unknown, min: number, max: number, fallback: number): number => {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    width: clamp(width, VIEWPORT_MIN.width, VIEWPORT_MAX.width, VIEWPORT_DEFAULT.width),
    height: clamp(height, VIEWPORT_MIN.height, VIEWPORT_MAX.height, VIEWPORT_DEFAULT.height),
  };
}

export function chatWorkspaceRoutes(deps: {
  host: ServerPackageHost;
  service: ReturnType<typeof createChatWorkspaceService>;
  profiles: ProfileRegistry;
}): RouteHandler {
  const { host, service, profiles } = deps;

  return async (request) => {
    const { path } = request;
    if (!path.startsWith("/api/chat-workspace/")) return false;
    const { method, url, body, json, space } = request;
    try {
      const storage = host.spaceStorage(space);
      const spaces = host.forSpace(space);
      const q = (key: string) => url.searchParams.get(key) ?? "";

      if (path === "/api/chat-workspace/capability" && method === "GET") {
        json(200, service.capability());
        return true;
      }
      if (path === "/api/chat-workspace/providers" && method === "GET") {
        json(200, { providers: service.listProviders() });
        return true;
      }
      if (path === "/api/chat-workspace/settings" && method === "GET") {
        json(200, await service.getSettings(storage));
        return true;
      }
      if (path === "/api/chat-workspace/settings" && method === "PUT") {
        const input = await body() as unknown as ChatWorkspaceSettingsDto;
        json(200, await service.putSettings(space, storage, { ...await loadSettings(storage), ...input }));
        return true;
      }
      if (path === "/api/chat-workspace/profiles" && method === "GET") {
        json(200, { profiles: await service.listProfiles(space, storage) });
        return true;
      }
      if (path === "/api/chat-workspace/profiles" && method === "POST") {
        const input = await body();
        json(200, await service.createProfile(space, storage, {
          providerId: String(input.providerId ?? ""),
          ...(input.name ? { name: String(input.name) } : {}),
          ...(input.customUrl ? { customUrl: String(input.customUrl) } : {}),
        }));
        return true;
      }

      let match = path.match(/^\/api\/chat-workspace\/profiles\/([^/]+)$/);
      if (match && method === "PATCH") {
        const input = await body();
        json(200, await service.patchProfile(space, storage, match[1]!, {
          ...(input.name ? { name: String(input.name) } : {}),
          ...(Array.isArray(input.approvedOrigins) ? { approvedOrigins: input.approvedOrigins as string[] } : {}),
        }));
        return true;
      }
      if (match && method === "DELETE") {
        await service.deleteProfile(space, storage, match[1]!);
        json(200, { ok: true });
        return true;
      }

      match = path.match(/^\/api\/chat-workspace\/profiles\/([^/]+)\/clear-data$/);
      if (match && method === "POST") {
        await service.clearProfileData(space, storage, match[1]!);
        json(200, { ok: true });
        return true;
      }

      match = path.match(/^\/api\/chat-workspace\/projects\/([^/]+)\/workspace$/);
      if (match && method === "GET") {
        const projectId = match[1]!;
        const project = await spaces.projects.get(projectId);
        if (!project) { json(404, { error: "not-found" }); return true; }
        json(200, await service.getWorkspace(storage, projectId, space));
        return true;
      }

      match = path.match(/^\/api\/chat-workspace\/projects\/([^/]+)\/tabs$/);
      if (match && method === "POST") {
        const projectId = match[1]!;
        const project = await spaces.projects.get(projectId);
        if (!project) { json(404, { error: "not-found" }); return true; }
        const input = await body();
        json(200, await service.createTab({
          ctx: space,
          storage,
          projectId,
          profileId: String(input.profileId ?? ""),
          ...(input.url ? { url: String(input.url) } : {}),
        }));
        return true;
      }

      match = path.match(/^\/api\/chat-workspace\/tabs\/([^/]+)$/);
      if (match && method === "DELETE") {
        const tabId = match[1]!;
        const projectId = q("projectId");
        if (!projectId) { json(400, { error: "invalid-input", message: "projectId required" }); return true; }
        const project = await spaces.projects.get(projectId);
        if (!project) { json(404, { error: "not-found" }); return true; }
        json(200, await service.closeTab(space, storage, projectId, tabId));
        return true;
      }

      match = path.match(/^\/api\/chat-workspace\/tabs\/([^/]+)\/state$/);
      if (match && method === "GET") {
        const tabId = match[1]!;
        const projectId = q("projectId");
        if (!projectId) { json(400, { error: "invalid-input", message: "projectId required" }); return true; }
        const project = await spaces.projects.get(projectId);
        if (!project) { json(404, { error: "not-found" }); return true; }
        const { tab } = await service.resolveTab(space, storage, projectId, tabId);
        const state = service.getTabState(tabId);
        json(200, state ?? {
          tab,
          loading: profiles.getPage(tabId)?.current().loading ?? false,
          canGoBack: true,
          canGoForward: true,
          pendingApproval: null,
          pendingPopups: [],
          pendingFileChooser: false,
          hibernated: tab.hibernated,
          crashed: false,
          unreachable: false,
          profileRestarted: false,
          downloadBlocked: false,
          liveTabCount: service.liveTabCount(),
        });
        return true;
      }

      match = path.match(/^\/api\/chat-workspace\/tabs\/([^/]+)\/clipboard\/(copy|paste)$/);
      if (match && method === "POST") {
        const tabId = match[1]!;
        const clipAction = match[2]!;
        const input = await body() as JsonObject;
        const projectId = q("projectId") || String(input.projectId ?? "");
        await service.resolveTab(space, storage, projectId, tabId);
        let page = profiles.getPage(tabId);
        if (!page) page = await service.wakeTab(space, storage, projectId, tabId);
        if (!page) throw err("not-found", "tab not live");
        if (clipAction === "copy") {
          const text = await page.copySelection();
          json(200, { text });
          return true;
        }
        await page.insertText(String(input.text ?? ""));
        json(200, { ok: true, state: page.current() });
        return true;
      }

      const tabAction = path.match(/^\/api\/chat-workspace\/tabs\/([^/]+)\/([^/]+)$/);
      if (tabAction && method === "POST") {
        const tabId = tabAction[1]!;
        const action = tabAction[2]!;
        const input = await body() as JsonObject;
        const projectId = q("projectId") || String(input.projectId ?? "");
        if (!projectId) { json(400, { error: "invalid-input", message: "projectId required" }); return true; }
        const project = await spaces.projects.get(projectId);
        if (!project) { json(404, { error: "not-found" }); return true; }
        await service.resolveTab(space, storage, projectId, tabId);
        let page = profiles.getPage(tabId);
        if (!page && (action === "activate" || action === "restore")) {
          page = await service.wakeTab(space, storage, projectId, tabId);
        }
        if (!page && action !== "restore" && action !== "activate"
          && action !== "close" && action !== "close-others" && action !== "move"
          && action !== "pin" && action !== "change-profile" && action !== "duplicate") {
          throw err("not-found", "tab not live");
        }
        switch (action) {
          case "close":
            json(200, await service.closeTab(space, storage, projectId, tabId));
            return true;
          case "close-others":
            json(200, await service.closeOthers(space, storage, projectId, tabId));
            return true;
          case "move":
            json(200, await service.moveTab(space, storage, projectId, tabId, {
              ...(input.beforeId ? { beforeId: String(input.beforeId) } : {}),
              ...(input.index !== undefined ? { index: Number(input.index) } : {}),
            }));
            return true;
          case "pin":
            json(200, await service.pinTab(space, storage, projectId, tabId, Boolean(input.pinned ?? true)));
            return true;
          case "change-profile":
            json(200, await service.changeProfile(space, storage, projectId, tabId, String(input.profileId ?? "")));
            return true;
          case "duplicate":
            json(200, await service.duplicateTab(space, storage, projectId, tabId));
            return true;
          case "navigate":
            await page!.goto(String(input.url ?? ""));
            break;
          case "back":
            await page!.back();
            break;
          case "forward":
            await page!.forward();
            break;
          case "reload":
            await page!.reload();
            break;
          case "stop":
            await page!.stop();
            break;
          case "resize":
            await page!.resize(clampViewport(input.width, input.height));
            break;
          case "activate":
            json(200, await service.activateTab(space, storage, projectId, tabId));
            return true;
          case "hibernate":
            await profiles.hibernateTab(tabId);
            break;
          case "restore":
            await profiles.restoreTab(tabId, String(input.url ?? profiles.getTab(tabId)?.url ?? "about:blank"));
            break;
          case "approve-origin": {
            const mode = String(input.mode ?? "always") === "once" ? "once" : "always";
            await profiles.approveOrigin(
              profiles.getTab(tabId)!.profileId,
              String(input.origin ?? ""),
              mode,
              async (origins) => {
                const resolved = await service.resolveTab(space, storage, projectId, tabId);
                await service.patchProfile(space, storage, resolved.profile.id, { approvedOrigins: origins });
              },
            );
            if (input.retryUrl) {
              const retryPage = profiles.getPage(tabId) ?? await service.wakeTab(space, storage, projectId, tabId);
              if (retryPage) await retryPage.goto(String(input.retryUrl));
            }
            break;
          }
          case "input":
            if (input.inputType === "mouse") {
              await page!.mouse({
                kind: String(input.kind ?? "click") as "move" | "down" | "up" | "click" | "dblclick",
                x: Number(input.x ?? 0),
                y: Number(input.y ?? 0),
                ...(input.button ? { button: String(input.button) as "left" | "middle" | "right" } : {}),
                ...(Array.isArray(input.modifiers) ? { modifiers: input.modifiers as Array<"Alt" | "Control" | "Meta" | "Shift"> } : {}),
              });
            } else if (input.inputType === "wheel") {
              await page!.wheel(Number(input.dx ?? 0), Number(input.dy ?? 0), Number(input.x ?? 0), Number(input.y ?? 0));
            } else if (input.inputType === "key") {
              await page!.key({
                kind: String(input.kind ?? "press") as "down" | "up" | "press",
                key: String(input.key ?? ""),
                ...(Array.isArray(input.modifiers) ? { modifiers: input.modifiers as Array<"Alt" | "Control" | "Meta" | "Shift"> } : {}),
              });
            } else if (input.inputType === "text") {
              await page!.insertText(String(input.text ?? ""));
            } else if (input.kind === "wheel") {
              await page!.wheel(Number(input.dx ?? 0), Number(input.dy ?? 0), Number(input.x ?? 0), Number(input.y ?? 0));
            } else if (input.kind === "key") {
              await page!.key(input as never);
            } else {
              await page!.mouse(input as never);
            }
            break;
          default:
            throw err("invalid-input", `unknown tab action ${action}`);
        }
        json(200, { ok: true, state: page?.current() });
        return true;
      }

      match = path.match(/^\/api\/chat-workspace\/tabs\/([^/]+)\/upload$/);
      if (match && method === "POST") {
        const tabId = match[1]!;
        const input = await body();
        const projectId = q("projectId") || String(input.projectId ?? "");
        if (!projectId) { json(400, { error: "invalid-input", message: "projectId required" }); return true; }
        const project = await spaces.projects.get(projectId);
        if (!project) { json(404, { error: "not-found" }); return true; }
        await service.resolveTab(space, storage, projectId, tabId);
        let page = profiles.getPage(tabId);
        if (!page) page = await service.wakeTab(space, storage, projectId, tabId);
        if (!page) throw err("not-found", "tab not live");
        const uploadPage = page as { setFiles?(files: Array<{ name: string; mimeType: string; buffer: Buffer }>): Promise<void> };
        const data = Buffer.from(String(input.data ?? ""), "base64");
        if (data.length > 25 * 1024 * 1024) throw err("invalid-input", "file too large (max 25 MB)");
        await uploadPage.setFiles?.([{ name: String(input.name ?? "upload"), mimeType: String(input.mimeType ?? "application/octet-stream"), buffer: data }]);
        json(200, { ok: true });
        return true;
      }

      match = path.match(/^\/api\/chat-workspace\/tabs\/([^/]+)\/popup\/([^/]+)\/(input|close)$/);
      if (match && method === "POST") {
        const tabId = match[1]!;
        const popupId = match[2]!;
        const popupAction = match[3]!;
        const input = await body() as JsonObject;
        const projectId = q("projectId") || String(input.projectId ?? "");
        if (!projectId) { json(400, { error: "invalid-input", message: "projectId required" }); return true; }
        const project = await spaces.projects.get(projectId);
        if (!project) { json(404, { error: "not-found" }); return true; }
        await service.resolveTab(space, storage, projectId, tabId);
        if (popupAction === "close") {
          await profiles.closePopup(tabId, popupId);
        } else {
          await profiles.popupInput(tabId, popupId, input);
        }
        json(200, { ok: true });
        return true;
      }

      return false;
    } catch (error) {
      const failure = error as Error & { code?: string };
      json(STATUS[failure.code ?? ""] ?? 500, { error: failure.code ?? "internal", message: failure.message });
      return true;
    }
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const profiles = host.services.get(serverServiceKey<ProfileRegistry>("browser.profiles")) ?? null;
  const service = createChatWorkspaceService(profiles);
  const frameBus = createChatWorkspaceFrameBus({
    resolveSpaceId: (tabId) => service.tabSpaceId(tabId),
    onFrame: (cb) => service.onFrame(cb),
    onEvent: (cb) => service.onEvent(cb),
    setTabStream: (tabId, visible, quality) => service.setTabStream(tabId, visible, quality),
  });
  host.services.provide(serverServiceKey("chat-workspace"), service);
  host.services.provide(serverServiceKey("chat-workspace.frames"), frameBus);
  let routes: RouteHandler | null = null;
  return {
    remoteAccess: localOnlyRemoteAccess(["chat-workspace"]) as RemoteAccessPolicy,
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      if (!profiles) return;
      routes ??= chatWorkspaceRoutes({ host, service, profiles });
    },
  };
}
