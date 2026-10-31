/** Pi 0.85.x starts its async CLI without awaiting it. With piped stdio Node
 * can see an empty event loop and exit before RPC installs its stdin readers.
 * This bootstrap keeps one inert timer alive for the RPC process lifetime;
 * Pi's RPC shutdown path exits explicitly when stdin closes or it is signaled. */
export const PI_BOOTSTRAP_SOURCE = String.raw`import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const entry = process.env.POLYTH_PI_ENTRY;
const rawArgs = process.env.POLYTH_PI_NATIVE_ARGS;
if (!entry || !rawArgs) process.exit(64);
let args;
try { args = JSON.parse(rawArgs); } catch { process.exit(64); }
if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) process.exit(64);
delete process.env.POLYTH_PI_ENTRY;
delete process.env.POLYTH_PI_NATIVE_ARGS;
process.argv = [process.execPath, entry, ...args];

setInterval(() => {}, 1_000);
await import(pathToFileURL(realpathSync(entry)).href);
`;
