import { existsSync } from "node:fs";
import { join } from "node:path";

export {
  checkoutProblem,
  createCheckoutUpdater,
  runProcess,
  type BuildStep,
  type CheckoutUpdaterOptions,
  type Ran,
  type Runner,
} from "./updater.ts";

/** The source checkout this package was loaded from, or null when it was
 *  loaded from a packaged build (no `.git` beside `packages/`). */
export function checkoutRoot(here: string = import.meta.dirname): string | null {
  const root = join(here, "..", "..", "..");
  return existsSync(join(root, ".git")) && existsSync(join(root, "packages", "server", "package.json")) ? root : null;
}
