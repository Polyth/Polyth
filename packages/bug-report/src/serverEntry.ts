// The report sheet is browser-only: the desktop shell captures and sends.
// This entry exists so the package is discovered, can be turned off in
// Settings → Packages, and its web entry is activated. It adds no routes.
import type { ServerPackage, ServerPackageHost } from "@polyth/plugins";

export default function registerPackage(_host: ServerPackageHost): ServerPackage {
  return {};
}
