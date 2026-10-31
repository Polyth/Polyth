// Bundled entry of the `polyth` CLI shipped inside Polyth Desktop
// (resources/cli/polyth.cjs, run by the app binary with ELECTRON_RUN_AS_NODE).
import { main } from "../../../packages/cli/src/main.ts";

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
