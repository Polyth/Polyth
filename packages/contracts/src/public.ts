import type { PackageCategory, ProjectAffinity, ProjectComposition } from "./projectComposition.ts";

declare module "./index.ts" {
  interface Project {
    /** Absent on legacy projects; reads never opt them into filtering. */
    composition?: ProjectComposition;
  }

  interface ProjectPatch {
    /** null explicitly restores general/legacy discovery without deleting layouts. */
    composition?: ProjectComposition | null;
  }

  interface ProjectService {
    add(path: string, name?: string, composition?: ProjectComposition): Promise<Project>;
    create(path: string, name?: string, composition?: ProjectComposition): Promise<Project>;
  }

  interface PackageDescriptorDto {
    category?: PackageCategory;
    projectAffinity?: ProjectAffinity;
  }
}

export * from "./index.ts";
export type {
  PackageCategory,
  ProjectAffinity,
  ProjectComposition,
  ProjectDirection,
} from "./projectComposition.ts";
