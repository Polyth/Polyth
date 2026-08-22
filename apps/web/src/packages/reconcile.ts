import type { PackageDescriptorDto } from "@polyth/contracts";

interface PackageReconcileContext {
  packageStates: Map<string, boolean>;
  applyCanonicalState(id: string): void;
  notify(): void;
}

let context: PackageReconcileContext | undefined;

export function configurePackageReconcile(next: PackageReconcileContext): void {
  context = next;
}

export function reconcilePackage(pkg: PackageDescriptorDto): void {
  if (!context) return;
  context.packageStates.set(pkg.id, pkg.enabled);
  context.applyCanonicalState(pkg.id);
  context.notify();
}
