import type { ProjectToolScope, ToolAvailability } from "@polyth/terminal/tool-types";
export interface TerraformRoot { directory: string; files: string[]; initialized: boolean }
export interface TerraformSnapshot {
  scope: ProjectToolScope;
  cli: ToolAvailability;
  roots: TerraformRoot[];
  plans: string[];
  truncated: boolean;
}
export type TerraformAction = "init" | "validate" | "format-check" | "plan";
export type TerraformChangeAction = "create" | "update" | "delete" | "replace" | "read" | "forget" | "other";
export interface TerraformChange { address: string; type: string; action: TerraformChangeAction }
export interface TerraformPlanSummary {
  changes: TerraformChange[];
  counts: { create: number; update: number; delete: number; replace: number; read: number; forget: number; other: number };
  terraformVersion?: string;
  applyable?: boolean;
  errored?: boolean;
}
