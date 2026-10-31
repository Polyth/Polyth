import type {
  HarnessCapabilityEvidence,
  HarnessContext,
  JsonObject,
  JsonValue,
  McpServerDto,
  MutationOutcome,
  SpaceContext,
} from "./index.ts";

/** Space is the existing shared tenant boundary; project is an explicit child. */
export type CapabilityInstallationScope = "space" | "project";

/** Inventory returned by an explicit MCP initialize + tools/list check. */
export interface McpToolDto {
  name: string;
  description?: string;
  inputSchema: JsonObject;
}

export interface McpInspectionDto {
  ok: boolean;
  message: string;
  checkedAt: number;
  tools: McpToolDto[];
  serverInfo?: { name: string; version: string };
}

/** Who owns an MCP server (Spaces §14.6): the Space (Space or project scope,
 * managed by Space admins) or one person (visible only to them, and attached
 * only to their own private chats). */
export type McpServerOwner = "space" | "person";

export interface McpInstallationDto extends McpServerDto {
  /** `person` for a person-owned server; Space-owned rows keep space/project. */
  scope: CapabilityInstallationScope | "person";
  projectId?: string;
  owner?: McpServerOwner;
  /** Can the caller change this row? Absent means the pre-ownership contract. */
  canManage?: boolean;
  /** Arguments and URL query were withheld from a caller who cannot manage
   * the server. Secret values are never returned to anyone. */
  redacted?: boolean;
  /** Cached protocol check, cleared when configuration changes. */
  inspection?: McpInspectionDto;
}

/** What the caller may do with MCP servers in the current Space. */
export interface McpAccessDto {
  /** Space admins add, edit and remove Space and project servers. */
  canManageSpace: boolean;
  /** Signed-in people (member or above) may keep their own servers. */
  canManagePersonal: boolean;
}

/** The acting person and chat for an agent's MCP access. Personal servers
 * are visible only when `actorUserId` owns `sessionId` and it is private. */
export interface McpSessionScope {
  sessionId: string;
  actorUserId?: string;
}

export interface McpToolCallResult {
  content: JsonValue[];
  isError?: boolean;
}

/** Trusted service behind Polyth's permission-gated portable MCP tool. */
export interface ProjectMcpService {
  /** With `session`, also the actor's personal servers when the chat qualifies. */
  list(space: SpaceContext, projectId: string, session?: McpSessionScope): McpInstallationDto[];
  tools(space: SpaceContext, id: string, projectId: string, session?: McpSessionScope): McpInspectionDto;
  test(space: SpaceContext, id: string, projectId: string, session?: McpSessionScope): Promise<McpInspectionDto>;
  call(space: SpaceContext, id: string, projectId: string, input: {
    toolName: string;
    arguments: JsonObject;
    sessionId: string;
    cwd: string;
    signal?: AbortSignal;
    actorUserId?: string;
  }): Promise<McpToolCallResult>;
}

/** Native folders are discovery sources, not Polyth installation destinations. */
export type NativeSkillScope =
  | "project-opencode" | "user-opencode"
  | "project-claude" | "user-claude"
  | "project-agents" | "user-agents";
export type SkillScope = CapabilityInstallationScope | NativeSkillScope;

export interface SkillInstallationDto {
  name: string;
  description: string;
  instructions: string;
  disallowedTools?: string[];
  scope: SkillScope;
  projectId?: string;
  /** Native discoveries are read-only. Copy one into a managed scope to edit it. */
  readOnly?: boolean;
  revision?: number;
}

export interface SkillInstallationInput {
  name: string;
  description: string;
  instructions: string;
  disallowedTools?: string[];
  /** Zero creates; an existing installation requires its current revision. */
  expectedRevision?: number;
}

/** A plugin installed through a harness's own plugin system (Claude Code
 * plugins, Codex plugins, OpenCode npm plugins, Pi packages, Antigravity
 * plugins). Polyth reads and manages these in the harness's native scope; it
 * does not own them as desired capabilities. */
export type NativePluginScope = "user" | "project" | "local" | "synced" | "managed";
export type NativePluginSourceKind = "marketplace" | "npm" | "git" | "local" | "url" | "unknown";
export type NativePluginComponentKind =
  | "skill"
  | "command"
  | "agent"
  | "hook"
  | "mcp-server"
  | "tool"
  | "native-code";
/** What Polyth sessions actually get from a component when the plugin is enabled. */
export type NativePluginEffect = "active" | "hidden-by-polyth" | "emulated" | "unsupported" | "unknown";

export interface NativePluginComponentDto {
  kind: NativePluginComponentKind;
  count: number;
  names?: string[];
  effect: NativePluginEffect;
  reason?: string;
}

export interface NativePluginDto {
  harnessId: string;
  /** Native reference used for mutations. */
  id: string;
  name: string;
  version?: string;
  source: { kind: NativePluginSourceKind; ref?: string };
  scope: NativePluginScope;
  projectPath?: string;
  enabled: boolean | "unknown";
  components?: NativePluginComponentDto[];
  /** Stage `discovered` when it comes from a native list. */
  evidence: HarnessCapabilityEvidence;
  readOnly?: boolean;
  note?: string;
}

export interface NativePluginMarketplaceDto {
  name: string;
  source?: string;
  ref?: string;
}

export type NativePluginAction = "install" | "uninstall" | "enable" | "disable" | "update";

export interface NativePluginSupportDto {
  actions: NativePluginAction[];
  installScopes: NativePluginScope[];
  /** Short example of an install reference this harness accepts. */
  installHint: string;
  applies: "next-session" | "runtime-restart";
  marketplaces: boolean;
  /** Install accepts a JSON object of plugin options (OpenCode's
   * `["spec", { … }]` entry form). Options may hold credentials: they are
   * written to the harness's own config and never echoed back or logged. */
  installOptions?: boolean;
}

export interface NativePluginListDto {
  harnessId: string;
  support: NativePluginSupportDto;
  plugins: NativePluginDto[];
  marketplaces?: NativePluginMarketplaceDto[];
  warnings?: string[];
  checkedAt: number;
  /** The project that `project`/`local` scopes refer to. Absent when the
   * request named no project: those scopes then cannot be changed. */
  project?: { id: string; name: string; path: string };
}

export interface NativePluginMutationInput {
  action: NativePluginAction;
  plugin: string;
  scope?: NativePluginScope;
  /** Plugin options for `install`, only when `support.installOptions`. A plain
   * JSON object; never logged, echoed or returned in a list. */
  options?: Record<string, unknown>;
}

/** Always delivered as a successful response: the native outcome is data, so a
 * refused command is never mistaken for an unconfirmed mutation. */
export interface NativePluginMutationResponseDto {
  outcome: "confirmed" | "rejected" | "unknown";
  operationId: string;
  code?: string;
  message?: string;
  pendingRestart: boolean;
  /** Re-read after the mutation; absent if the re-read failed. */
  list?: NativePluginListDto;
}

/** Backend-owned access to a harness's native plugin system. Each account of a
 * multi-account harness has its own manager bound to that account's home. */
export interface HarnessNativePluginManager {
  /** Process-free. */
  support(context: HarnessContext): NativePluginSupportDto;
  list(context: HarnessContext, options?: { signal?: AbortSignal }): Promise<NativePluginListDto>;
  /** Runs one native command. Never retries; an unknown outcome means re-read. */
  mutate?(
    context: HarnessContext,
    input: NativePluginMutationInput,
    options: { operationId: string; signal?: AbortSignal },
  ): Promise<MutationOutcome<{ pendingRestart: boolean; message?: string }>>;
}

/** Where a harness-native skill was found. `plugin` skills come from a native
 * plugin that is installed and enabled in the harness itself. */
export type HarnessNativeSkillSource = "user" | "project" | "plugin";

export interface HarnessNativeSkillDto {
  /** The name the harness matches, `plugin:skill` for plugin skills. */
  name: string;
  description?: string;
  source: HarnessNativeSkillSource;
  /** Native plugin id for `plugin` skills. */
  plugin?: string;
  /** Polyth offers this skill to the harness's model. */
  enabled: boolean;
}

/** Polyth-owned policy for one harness's own skills. Polyth starts native
 * sessions with only its own skills unless the Space opts in to inherit the
 * harness's skills; inherited skills can still be muted one by one. */
export interface HarnessNativeSkillListDto {
  harnessId: string;
  inherit: boolean;
  skills: HarnessNativeSkillDto[];
  /** False when this deployment or target cannot inherit native skills. */
  supported: boolean;
  unsupportedReason?: string;
  applies: "next-session";
  checkedAt: number;
}

export interface HarnessNativeSkillPolicyPatch {
  inherit?: boolean;
  /** Mute (`false`) or restore (`true`) one inherited skill. */
  skill?: { name: string; enabled: boolean };
}

/** Backend-owned discovery of a harness's own skills plus the Space's policy
 * for them. Never edits the harness's native files. */
export interface HarnessNativeSkillManager {
  list(context: HarnessContext): Promise<HarnessNativeSkillListDto>;
  update(context: HarnessContext, patch: HarnessNativeSkillPolicyPatch): Promise<HarnessNativeSkillListDto>;
}
