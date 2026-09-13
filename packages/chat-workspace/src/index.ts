export {
  createChatWorkspaceFrameBus,
  frameBusKey,
} from "./frameBus.ts";
export type {
  ChatWorkspaceFrame,
  ChatWorkspaceFrameBus,
  ChatWorkspaceTabEvent,
} from "@polyth/contracts";

export { createChatWorkspaceService, type ChatWorkspaceService } from "./service.ts";
export { CHAT_PROVIDERS, providerById } from "./providers.ts";
export {
  CHAT_WORKSPACE_PROVIDER_ADAPTERS,
  buildExternalChatHandoff,
  normalizeExternalChatText,
  providerAdapter,
  sanitizeExternalChatUrl,
  type ChatWorkspaceProviderAdapter,
  type ChatWorkspaceProviderId,
  type ExternalChatHandoff,
} from "./providerAdapters.ts";
export {
  DEFAULT_CHAT_WORKSPACE_RUNTIME_PREFERENCE,
  selectChatWorkspaceRuntime,
  type ChatWorkspaceRuntimeCapability,
  type ChatWorkspaceRuntimeKind,
  type ChatWorkspaceRuntimePreference,
  type ChatWorkspaceRuntimeSelection,
} from "./runtime.ts";
export {
  CHAT_WORKSPACE_DEVICE_PROTOCOL_VERSION,
  assertSafeDeviceProtocolPayload,
  type ChatWorkspaceDeviceAck,
  type ChatWorkspaceDeviceCommand,
  type ChatWorkspaceDeviceCommandInput,
  type ChatWorkspaceDeviceEvent,
  type ChatWorkspaceDeviceHello,
} from "./deviceRuntimeProtocol.ts";
export {
  createChatWorkspaceDeviceRuntimeRegistry,
  type ChatWorkspaceDeviceRuntimeRegistry,
  type ChatWorkspaceDeviceTransport,
} from "./deviceRuntimeRegistry.ts";
export {
  createChatWorkspaceDeviceWorkerRuntime,
  type ChatWorkspaceDeviceWorkerRuntime,
} from "./deviceWorkerRuntime.ts";
export {
  connectChatWorkspaceDeviceRuntime,
  type ChatWorkspaceDeviceRuntimeClient,
} from "./deviceRuntimeClient.ts";
