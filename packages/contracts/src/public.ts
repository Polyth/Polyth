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

  /** A project in the Polyth folder: the server chooses the folder, so no path
   *  is part of this input. */
  interface ManagedProjectInput {
    name: string;
    composition?: ProjectComposition;
    /** Makes the create idempotent: a resend after a lost response returns the
     *  same project instead of making a second one. */
    clientOperationId?: string;
  }

  interface ProjectService {
    add(path: string, name?: string, composition?: ProjectComposition): Promise<Project>;
    create(path: string, name?: string, composition?: ProjectComposition): Promise<Project>;
    /** Optional so old fakes remain valid. */
    createManaged?(input: ManagedProjectInput): Promise<Project>;
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
