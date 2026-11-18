// Source execution uses discovery; the server build (build.ts) replaces this
// module with static imports generated from the same polyth.serverEntry manifests.
import { resolve } from "node:path";
import { loadServerPackages } from "../../../scripts/server-packages-bundle.ts";

export const serverAppPackages = await loadServerPackages(resolve(import.meta.dirname, "../../.."));
