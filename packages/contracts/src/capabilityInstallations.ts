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
  /** Where a managed copy came from. Absent for a skill written in Polyth. */
  origin?: SkillOrigin;
  /** Supporting files stored with this skill. Absent for instructions only. */
  bundle?: { files: number; bytes: number };
  /** The instructions were edited after this copy was taken. */
  modified?: boolean;
  /** Which harnesses receive this managed skill, and how. Absent means every
   * harness, on demand, including one added later. */
  reach?: SkillReachDto;
}

/** How one harness gets a managed skill: not at all, on demand (the harness
 * offers it as a skill), or always (its instructions join every session). */
export type SkillHarnessMode = "off" | "on" | "always";

/** What a harness no rule names gets. `all`: on demand, including harnesses
 * added later. `some`: nothing; only the harnesses and families named below.
 * `none`: no harness at all, while the choices below are kept for later. */
export type SkillReachDefault = "all" | "some" | "none";

/** A managed skill's reach. The most specific rule wins: a harness, then its
 * family (`SkillHarnessDto.family`), then the default. */
export interface SkillReachDto {
  default: SkillReachDefault;
  families?: Record<string, SkillHarnessMode>;
  harnesses?: Record<string, SkillHarnessMode>;
}

/** Provenance of a managed copy. `contentHash` covers every file of the copy,
 * so a changed source can be told from an unchanged one. */
export type SkillOrigin =
  | {
    kind: "catalog";
    sourceId: string;
    sourceLabel: string;
    repository: string;
    path: string;
    url?: string;
    commit?: string;
    contentHash: string;
    installedAt: number;
  }
  | {
    kind: "harness";
    harnessId: string;
    harnessName: string;
    nativeName: string;
    contentHash: string;
    installedAt: number;
  };

/** What the caller may change. Mirrors the server's write checks so the UI
 * never offers a refused action; the server still enforces each one. */
export interface SkillAccessDto {
  project: boolean;
  space: boolean;
  /** Add and remove catalog sources for the whole Space. */
  sources: boolean;
  /** Change which of a harness's own skills it inherits (instance owner). */
  nativePolicy: boolean;
}

/** A repository the catalog reads skills from. */
export interface SkillCatalogSourceDto {
  id: string;
  label: string;
  /** `owner/repo`, or the group path on GitLab. */
  repository: string;
  url: string;
  /** Curated by Polyth; cannot be removed. */
  builtin: boolean;
  description?: string;
  stars?: number;
  license?: string;
  /** Owner picture as a data URL, fetched and checked by the server. */
  avatar?: string;
  /** Last change in the repository. */
  updatedAt?: number;
  /** When this server last read the repository. */
  syncedAt?: number;
  commit?: string;
  skillCount: number;
  sync: "idle" | "syncing" | "error";
  /** Why the last read failed. Earlier skills stay listed. */
  error?: string;
}

/** A catalog skill's install state in one scope. */
export interface SkillCatalogInstalledDto {
  scope: CapabilityInstallationScope;
  state: "current" | "outdated" | "modified";
}

export interface SkillCatalogSkillDto {
  /** `<sourceId>:<path>`. */
  id: string;
  sourceId: string;
  name: string;
  /** Readable form of the name. */
  title: string;
  description: string;
  /** Group inside the repository (`engineering`, a plugin name). */
  collection?: string;
  path: string;
  /** SHA-256 of every file. Install names the hash that was reviewed. */
  contentHash: string;
  files: number;
  bytes: number;
  /** Files an agent can run. */
  scripts: number;
  license?: string;
  /** Invisible Unicode in the instructions, which can hide text from a reader. */
  hiddenText?: boolean;
  /** Over the install limits; listed so a search still explains the miss. */
  tooLarge?: boolean;
  /** On the "Start here" shelf. */
  featured?: boolean;
  installed?: SkillCatalogInstalledDto[];
  /** A different skill holds this name in the listed scopes. */
  nameTakenIn?: CapabilityInstallationScope[];
}

export interface SkillCatalogDto {
  sources: SkillCatalogSourceDto[];
  skills: SkillCatalogSkillDto[];
  access: SkillAccessDto;
}

export type SkillFileKind = "text" | "script" | "binary";

export interface SkillFileDto {
  path: string;
  bytes: number;
  kind: SkillFileKind;
}

/** Everything a person reviews before installing. */
export interface SkillCatalogDetailDto {
  skill: SkillCatalogSkillDto;
  source: SkillCatalogSourceDto;
  instructions: string;
  files: SkillFileDto[];
  url?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface SkillFilePreviewDto {
  path: string;
  kind: SkillFileKind;
  bytes: number;
  /** Absent for a binary file. */
  text?: string;
  truncated?: boolean;
}

export interface SkillCatalogInstallInput {
  id: string;
  /** The hash the person reviewed; a newer copy is refused, not installed. */
  contentHash: string;
  scope: CapabilityInstallationScope;
  projectId?: string;
  /** Replace a different skill that already holds the name. */
  replace?: boolean;
}

/** How Polyth's own skills reach one harness. */
export type SkillDelivery = "native" | "prompt" | "none";

/** One harness added to this Polyth, as the skill surfaces show it. */
export interface SkillHarnessDto {
  id: string;
  name: string;
  /** The accounts of one native harness share a family, named by its default
   * harness id (`claude` for `claude` and `claude-work`). A harness with one
   * account is a family of its own. */
  family: string;
  /** The family's own name, without an account. */
  familyName: string;
  /** Names this account inside its family. Absent on the default account. */
  accountLabel?: string;
  /** `#rrggbb`. */
  color?: string;
  delivery: SkillDelivery;
  /** It can enforce a skill's blocked tools, so such a skill reaches it. */
  enforcesBlockedTools: boolean;
  /** Whether Polyth can read this harness's own skills, and switch them. */
  nativeSkills: "controlled" | "listed" | "none";
  /** This harness's own skills reach its model at all. Off, none can be switched on one by one. */
  inherits: boolean;
}

/** A skill as one harness has it of its own. */
export interface SkillLibraryNativeDto {
  harnessId: string;
  source: HarnessNativeSkillSource;
  enabled: boolean;
  /** Polyth cannot switch this off: the harness loads it by itself. */
  locked: boolean;
  /** Polyth can read this skill's folder and copy it to every harness. */
  importable: boolean;
  /** The name that harness matches (`plugin:skill` for a plugin's skill). */
  nativeName: string;
}

/** One row of the library: one skill name across Polyth and every harness. */
export interface SkillLibraryEntryDto {
  name: string;
  /** Readable form of the name. */
  title: string;
  description: string;
  /** The Polyth-managed copy, without its instructions. */
  managed?: Omit<SkillInstallationDto, "instructions">;
  natives: SkillLibraryNativeDto[];
  /** Read-only folder Polyth found outside every harness's own list. */
  discoveredIn?: SkillScope;
  /** The source now differs from the managed copy. */
  updateAvailable?: boolean;
  /** Catalog id of the managed copy's source skill. */
  catalogId?: string;
  /** Picture of the managed copy's catalog source. */
  avatar?: string;
}

export interface SkillLibraryDto {
  harnesses: SkillHarnessDto[];
  skills: SkillLibraryEntryDto[];
  access: SkillAccessDto;
}

export interface SkillLibraryDetailDto {
  entry: SkillLibraryEntryDto;
  instructions: string;
  files: SkillFileDto[];
  url?: string;
}

export interface SkillAdoptInput {
  harnessId: string;
  /** The name that harness matches. */
  name: string;
  scope: CapabilityInstallationScope;
  projectId?: string;
  replace?: boolean;
}

/** One change to a managed skill's reach: exactly one of `default`, `family`
 * or `harness`. A `null` mode removes that rule, so the next broader one
 * applies. Choosing `some` keeps the skill where it works now; choosing `all`
 * clears every `off`. */
export interface SkillReachInput {
  name: string;
  scope: CapabilityInstallationScope;
  projectId?: string;
  default?: SkillReachDefault;
  family?: { id: string; mode: SkillHarnessMode | null };
  harness?: { id: string; mode: SkillHarnessMode | null };
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
/** `bundled` ships with the harness itself (Codex `.system`, Cursor `skills-cursor`). */
export type HarnessNativeSkillSource = "user" | "project" | "plugin" | "bundled";

export interface HarnessNativeSkillDto {
  /** The name the harness matches, `plugin:skill` for plugin skills. */
  name: string;
  description?: string;
  source: HarnessNativeSkillSource;
  /** Native plugin id for `plugin` skills. */
  plugin?: string;
  /** Polyth offers this skill to the harness's model. */
  enabled: boolean;
  /** The harness loads this by itself; Polyth cannot switch it off. */
  locked?: boolean;
  /** Polyth knows its name but not its folder, so it cannot be read or copied. */
  noFolder?: boolean;
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
  /** `policy`: the inherit switch and per-skill mute work. `none`: the harness
   * loads these by itself, so Polyth lists them read-only. Absent means `policy`. */
  control?: "policy" | "none";
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
  /** The folder holding one skill's `SKILL.md`, for reading or copying it into
   * Polyth. Undefined when it has none on this host (a plugin's skill, or a
   * name this harness does not have). Never returned to a client. */
  locate?(context: HarnessContext, name: string): Promise<string | undefined>;
}
