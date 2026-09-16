// Canonical bootstrap. The large runtime composition root lives in indexCore.ts
// and is admitted only after the account/tenancy authority is already ready.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanonicalSecurity } from "./canonicalSecurity.ts";
import { bindCanonicalSecurity } from "./runtimeSecurity.ts";
import { createSetupServer } from "./setupServer.ts";
import { boot as bootCore, type BootOptions } from "./indexCore.ts";

export * from "./indexCore.ts";
export type { BootOptions } from "./indexCore.ts";

const localOriginHost = (hostname: string): string => {
  const host = hostname.trim().toLowerCase();
  if (host === "127.0.0.1" || host === "localhost") return host;
  if (host === "::1" || host === "[::1]") return "[::1]";
  // A wildcard listener may still serve the trusted loopback browser. The
  // canonical HTTP adapter additionally verifies both socket endpoints, so a
  // LAN client cannot turn this origin into a credential bypass.
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return "127.0.0.1";
  throw Object.assign(
    new Error("Canonical browser identity currently requires a loopback HTTP listener; use Polyth Link for remote access"),
    { code: "insecure-transport" },
  );
};

export async function boot(opts: BootOptions = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 4400);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw Object.assign(new Error("Canonical server port must be an explicit TCP port"), { code: "invalid-input" });
  }
  const hostname = opts.hostname ?? process.env.HOST ?? "127.0.0.1";
  const origin = `http://${localOriginHost(hostname)}:${port}`;
  const dataDir = resolve(opts.dataDir ?? process.env.POLYTH_DATA_DIR ?? "./data");
  const security = createCanonicalSecurity({
    dataDir,
    origin,
    localOnly: true,
  });
  const binding = bindCanonicalSecurity(security);
  let closed = false;
  const closeAuthority = (): void => {
    if (closed) return;
    closed = true;
    binding.dispose();
    security.close();
  };

  try {
    const state = security.control.installation().state;
    if (state === "recovery") {
      throw Object.assign(new Error("Canonical security authority requires operator recovery"), { code: "recovery-required" });
    }
    if (state === "ready") {
      const runtime = await bootCore({ ...opts, port, hostname, dataDir });
      let shutdown: Promise<void> | undefined;
      return {
        ...runtime,
        shutdown() {
          if (!shutdown) {
            shutdown = runtime.shutdown().finally(closeAuthority);
          }
          return shutdown;
        },
      };
    }

    const setup = createSetupServer({
      security,
      webDist: resolve(opts.webDist ?? resolve(fileURLToPath(new URL("../../../apps/web/dist/", import.meta.url)))),
      version: "0.1.0",
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      const failed = (error: Error): void => rejectListen(error);
      setup.server.once("error", failed);
      setup.server.listen(port, hostname, () => {
        setup.server.off("error", failed);
        resolveListen();
      });
    });
    console.log(`[polyth] setup server on ${origin}  data=${dataDir}`);

    let shutdown: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      if (!shutdown) shutdown = setup.shutdown().finally(closeAuthority);
      return shutdown;
    };
    const sigint = (): void => { void stop().then(() => process.exit(0)); };
    const sigterm = (): void => { void stop().then(() => process.exit(0)); };
    process.once("SIGINT", sigint);
    process.once("SIGTERM", sigterm);
    return {
      server: setup.server,
      setup: true as const,
      state,
      async shutdown() {
        process.off("SIGINT", sigint);
        process.off("SIGTERM", sigterm);
        await stop();
      },
    };
  } catch (cause) {
    closeAuthority();
    throw cause;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void boot();
}
