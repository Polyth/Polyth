import type { PackageDescriptorDto } from "@polyth/contracts";
import { updateProjectPackageDescriptor } from "./projectRelevance.ts";

interface PackageReconcileContext {
  packageStates: Map<string, boolean>;
  applyCanonicalState(id: string): void | Promise<void>;
  notify(): void;
}

let context: PackageReconcileContext | undefined;

export function configurePackageReconcile(next: PackageReconcileContext): void {
  context = next;
}

export function reconcilePackage(pkg: PackageDescriptorDto): void {
  if (!context) return;
  updateProjectPackageDescriptor(pkg);
  context.packageStates.set(pkg.id, pkg.enabled);
  context.applyCanonicalState(pkg.id);
  context.notify();
}
