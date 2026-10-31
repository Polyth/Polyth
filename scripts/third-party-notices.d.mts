export interface BundledPackage {
  id: string;
  name: string;
  version: string;
  license: string;
  repository: string;
  author: string;
  files: Array<{ name: string; text: string }>;
}
interface MetafileLike {
  inputs: Record<string, unknown>;
}
export declare function packageRootOf(path: string): string | null;
export declare function readPackage(root: string): BundledPackage | null;
export declare function bundledPackages(metafiles: readonly MetafileLike[], workingDir?: string): BundledPackage[];
export declare function formatNotices(packages: readonly BundledPackage[], product: string): string;
export declare function writeThirdPartyNotices(
  file: string,
  metafiles: readonly MetafileLike[],
  options?: { product?: string; workingDir?: string },
): Promise<BundledPackage[]>;
