import type { ChatTabDto } from "@polyth/contracts";
import type { ExternalChatHandoff } from "./providerAdapters.ts";

/**
 * Logical protocol between the canonical Polyth host and a trusted Desktop
 * Chat Workspace worker. Transport/authentication are intentionally not owned
 * by this package; the protocol must ride the canonical paired-device layer.
 *
 * Provider pixels, cookies, storage state, clipboard contents and arbitrary DOM
 * never cross this boundary in local-rendering mode.
 */
export const CHAT_WORKSPACE_DEVICE_PROTOCOL_VERSION = 1 as const;

export type ChatWorkspaceHandoffAction = "add-to-agent" | "ask-agent" | "new-agent-chat";

export interface ChatWorkspaceDeviceHello {
  protocolVersion: typeof CHAT_WORKSPACE_DEVICE_PROTOCOL_VERSION;
  /** Informational on the wire. The host replaces it with the authenticated
   * Polyth Link principal before registration/routing. */
  deviceId: string;
  deviceName: string;
  platform: string;
  arch: string;
  capabilities: {
    localChromium: boolean;
    localRendering: boolean;
    persistentProfiles: boolean;
    explicitResponseHandoff: boolean;
  };
}

export type ChatWorkspaceDeviceCommand =
  | {
      kind: "profile.ensure";
      requestId: string;
      profileId: string;
      providerId: string;
      homeUrl: string;
      allowedOrigins: string[];
      approvedOrigins: string[];
    }
  | {
      kind: "profile.close";
      requestId: string;
      profileId: string;
    }
  | {
      kind: "tab.ensure";
      requestId: string;
      projectId: string;
      tab: Pick<ChatTabDto, "id" | "profileId" | "url" | "pinned">;
    }
  | {
      kind: "tab.activate" | "tab.close" | "tab.back" | "tab.forward" | "tab.reload" | "tab.stop" | "tab.hibernate";
      requestId: string;
      projectId: string;
      tabId: string;
    }
  | {
      kind: "tab.navigate" | "tab.restore";
      requestId: string;
      projectId: string;
      tabId: string;
      url: string;
    }
  | {
      kind: "tab.set-pinned";
      requestId: string;
      projectId: string;
      tabId: string;
      pinned: boolean;
    }
  | {
      kind: "tab.approve-origin";
      requestId: string;
      projectId: string;
      tabId: string;
      origin: string;
      mode: "once" | "always";
      retryUrl?: string;
    }
  | {
      /** User-triggered extraction only; never callable by an agent capability. */
      kind: "tab.extract";
      requestId: string;
      projectId: string;
      tabId: string;
      scope: "selection" | "response" | "latest-response";
      responseId?: string;
    };

/** Distributive omission preserves each discriminated-union variant. A plain
 * `Omit<ChatWorkspaceDeviceCommand, "requestId">` collapses variant-only
 * fields and makes the dispatcher accept an unsafe, weakly typed shape. */
export type ChatWorkspaceDeviceCommandInput =
  ChatWorkspaceDeviceCommand extends infer Command
    ? Command extends { requestId: string }
      ? Omit<Command, "requestId">
      : never
    : never;

export type ChatWorkspaceDeviceEvent =
  | {
      kind: "ready";
      hello: ChatWorkspaceDeviceHello;
    }
  | {
      kind: "tab.state";
      projectId: string;
      tabId: string;
      url: string;
      title: string;
      loading: boolean;
      hibernated: boolean;
    }
  | {
      kind: "tab.closed";
      projectId: string;
      tabId: string;
    }
  | {
      kind: "runtime.error";
      requestId?: string;
      code: string;
      message: string;
      tabId?: string;
    }
  | {
      /** Emitted only after a trusted, explicit user gesture in the Desktop provider surface. */
      kind: "handoff";
      eventId: string;
      action: ChatWorkspaceHandoffAction;
      handoff: ExternalChatHandoff;
    };

export interface ChatWorkspaceDeviceAck {
  requestId: string;
  ok: boolean;
  code?: string;
  message?: string;
}

const forbiddenPayloadKeys = new Set([
  "cookie",
  "cookies",
  "localStorage",
  "sessionStorage",
  "storageState",
  "dom",
  "html",
  "frame",
  "pixels",
  "screenshot",
  "clipboard",
]);

/** Defense-in-depth assertion for future serializers. Local mode is metadata +
 * trusted explicit handoff only; accidental browser-state transport is a bug. */
export function assertSafeDeviceProtocolPayload(value: unknown): void {
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (forbiddenPayloadKeys.has(key)) {
        throw Object.assign(new Error(`forbidden Chat Workspace device payload field: ${key}`), {
          code: "unsafe-device-payload",
        });
      }
      visit(child);
    }
  };
  visit(value);
}
