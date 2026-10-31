import type { DefaultRails, ProjectAffinity } from "@polyth/contracts/project-composition";

declare module "./index.ts" {
  interface SlotRegistration { projectAffinity?: ProjectAffinity }
  interface WidgetDefinition { projectAffinity?: ProjectAffinity }
  interface WidgetPlugin { projectAffinity?: ProjectAffinity }
  interface SurfaceDefinition { projectAffinity?: ProjectAffinity }
  interface CapabilityDefinition {
    projectAffinity?: ProjectAffinity;
    /** Where the launcher starts in a freshly arranged project of each kind
     * (`top` or `right` rail). Unlisted kinds start it under More. Omit to
     * keep `standardTier` wherever the package's directions match. */
    defaultRails?: DefaultRails;
  }
  interface WorkbenchProfileDefinition {
    /** Host-bound owner package id. Package callers should omit this. */
    ownerPackageId?: string;
    projectAffinity?: ProjectAffinity;
  }
  interface ProjectContextContribution { projectAffinity?: ProjectAffinity }
}

export * from "./index.ts";
