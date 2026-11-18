// The `polyth` CLI of a packaged server (dist/cli.mjs). It marks its own
// install so `polyth server start|setup-claim|break-glass` run the bundled
// entries beside it instead of a checkout's npm scripts.
import { resolve } from "node:path";
import { main } from "@polyth/cli";

process.env.POLYTH_SERVER_BUNDLE = resolve(import.meta.dirname, "..");
process.exitCode = await main(process.argv.slice(2));
