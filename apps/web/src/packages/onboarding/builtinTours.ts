// Tours for surfaces with no web installer of their own (built-in settings
// pages and server-side packages such as terminal or preview). Packages with
// a web installer register their tour from installXxxPackage instead, so
// disabling the package removes the tour with it.
import { registerPackageOnboarding } from "./registry.ts";
import { BUILTIN_TOURS } from "./tours/builtin.ts";
import { PACKAGES_TOUR } from "./tours/packages.ts";

let registered = false;

export function registerBuiltinPackageTours(): void {
  if (registered) return;
  registered = true;
  registerPackageOnboarding(PACKAGES_TOUR);
  for (const tour of BUILTIN_TOURS) registerPackageOnboarding(tour);
}
