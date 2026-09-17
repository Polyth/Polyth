import type { ProjectAffinity } from "@polyth/contracts/project-composition";

declare module "./index.ts" {
  interface SlotRegistration { projectAffinity?: ProjectAffinity }
  interface WidgetDefinition { projectAffinity?: ProjectAffinity }
  interface WidgetPlugin { projectAffinity?: ProjectAffinity }
  interface SurfaceDefinition { projectAffinity?: ProjectAffinity }
  interface CapabilityDefinition { projectAffinity?: ProjectAffinity }
  interface WorkbenchProfileDefinition {
    /** Host-bound owner package id. Package callers should omit this. */
    ownerPackageId?: string;
    projectAffinity?: ProjectAffinity;
  }
  interface ProjectContextContribution { projectAffinity?: ProjectAffinity }
}

export * from "./index.ts";
