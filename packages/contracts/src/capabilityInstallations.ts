import type { McpServerDto } from "./index.ts";

/** Space is the existing shared tenant boundary; project is an explicit child. */
export type CapabilityInstallationScope = "space" | "project";

export interface McpInstallationDto extends McpServerDto {
  scope: CapabilityInstallationScope;
  projectId?: string;
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
  /** Zero creates; an existing installation requires its current revision. */
  expectedRevision?: number;
}
