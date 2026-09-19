// Canonical bootstrap. The large runtime composition root lives in indexCore.ts
// and is admitted only after the account/tenancy authority is already ready.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthorityOutboxWorker } from "./authorityOutbox.ts";
import { createCanonicalSecurity, type CanonicalSecurity } from "./canonicalSecurity.ts";
import { inspectCanonicalInstallation } from "./controlPlanePreflight.ts";
import {
  bindCanonicalSecurity,
  bindCanonicalSecurityFactory,
  canonicalSecurity,
} from "./runtimeSecurity.ts";
import { createSetupServer } from "./setupServer.ts";
import { createProxyTrust } from "./trustedProxy.ts";
import {
  acquireDataDirectoryLease,
  boot as bootCore,
  type BootOptions,
} from "./indexCore.ts";

export * from "./indexCore.ts";
export type { BootOptions } from "./indexCore.ts";

const localOriginHost = (hostname: string): string => {
  const host = hostname.trim().toLowerCase();
  if (host === "127.0.0.1" || host === "localhost") return host;
  if (host === "::1" || host === "[::1]") return "[::1]";
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return "127.0.0.1";
  throw Object.assign(
    new Error("Canonical browser identity currently requires a loopback HTTP listener; use Polyth Link for remote access"),
    { code: "insecure-transport" },
  );
};

const recoveryRequired = (): Error => Object.assign(
  new Error("Canonical security authority requires operator recovery"),
  { code: "recovery-required" },
);

/**
 * Operator-declared public origin (POLYTH_PUBLIC_ORIGIN), for an installation
 * published behind a TLS-terminating reverse proxy. It is configuration, never
 * derived from Host or forwarded headers, and it is the one identity origin:
 * cookies, same-origin checks and passkey rpId all bind to it. This listener
 * terminates no TLS itself, so it is only honoured together with the exact
 * proxy peers allowed to report that TLS already happened.
 */
const canonicalPublicOrigin = (raw: string): string => {
  let url: URL;
  try { url = new URL(raw); } catch { throw invalidOrigin("POLYTH_PUBLIC_ORIGIN must be an absolute URL"); }
  if (url.protocol !== "https:" || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw invalidOrigin("POLYTH_PUBLIC_ORIGIN must be an https origin with no path, query or credentials");
  }
  if (createProxyTrust().size === 0) {
    throw invalidOrigin("POLYTH_PUBLIC_ORIGIN requires POLYTH_TRUSTED_PROXIES: this listener terminates no TLS");
  }
  return url.origin;
};
const invalidOrigin = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

export async function boot(opts: BootOptions = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 4400);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw Object.assign(new Error("Canonical server port must be an explicit TCP port"), { code: "invalid-input" });
  }
  const hostname = opts.hostname ?? process.env.HOST ?? "127.0.0.1";
  const publicOrigin = (process.env.POLYTH_PUBLIC_ORIGIN ?? "").trim();
  const origin = publicOrigin
    ? canonicalPublicOrigin(publicOrigin)
    : `http://${localOriginHost(hostname)}:${port}`;
  const dataDir = resolve(opts.dataDir ?? process.env.POLYTH_DATA_DIR ?? "./data");
  const preflight = inspectCanonicalInstallation(dataDir);
  if (preflight.kind === "existing" && preflight.state === "recovery") throw recoveryRequired();

  const createSecurity = (): CanonicalSecurity => createCanonicalSecurity({
    dataDir,
    origin,
    localOnly: publicOrigin === "",
  });

  if (preflight.kind === "existing" && preflight.state === "ready") {
    let security: CanonicalSecurity | null = null;
    const binding = bindCanonicalSecurityFactory(() => {
      const created = createSecurity();
      if (created.control.installation().state !== "ready") {
        created.close();
        throw recoveryRequired();
      }
      security = created;
      return created;
    });
    let closed = false;
    const closeAuthority = (): void => {
      if (closed) return;
      closed = true;
      binding.dispose();
      security?.close();
      security = null;
    };

    try {
      // indexCore acquires the canonical data-directory writer lease before
      // the first consumer calls canonicalSecurity(), so the lazy factory above
      // cannot open/migrate the control-plane outside the one-writer section.
      const runtime = await bootCore({ ...opts, port, hostname, dataDir });
      security = security ?? canonicalSecurity();
      if (!security || security.control.installation().state !== "ready") {
        await runtime.shutdown();
        throw recoveryRequired();
      }
      const authorityOutbox = createAuthorityOutboxWorker(security.control);
      authorityOutbox.start();
      let shutdown: Promise<void> | undefined;
      return {
        ...runtime,
        shutdown() {
          if (!shutdown) {
            shutdown = authorityOutbox.stop()
              .then(() => runtime.shutdown())
              .finally(closeAuthority);
          }
          return shutdown;
        },
      };
    } catch (cause) {
      closeAuthority();
      throw cause;
    }
  }

  // Fresh/setup installations have no core runtime to own the lock, so acquire
  // the writer lease before openControlPlane can create a sentinel, database or
  // schema migration. If another process completed setup while we waited, close
  // this lease and re-enter through the ready lazy-binding path.
  const writerLease = await acquireDataDirectoryLease(dataDir);
  let security: CanonicalSecurity | null = null;
  let binding: ReturnType<typeof bindCanonicalSecurity> | null = null;
  let closed = false;
  const closeAuthority = (): void => {
    if (closed) return;
    closed = true;
    binding?.dispose();
    binding = null;
    security?.close();
    security = null;
  };

  try {
    security = createSecurity();
    const state = security.control.installation().state;
    if (state === "recovery") throw recoveryRequired();
    if (state === "ready") {
      closeAuthority();
      await writerLease.release();
      return boot({ ...opts, port, hostname, dataDir });
    }
    binding = bindCanonicalSecurity(security);

    const setup = createSetupServer({
      security,
      webDist: resolve(opts.webDist ?? resolve(fileURLToPath(new URL("../../../apps/web/dist/", import.meta.url)))),
      version: "0.1.0",
    });
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const failed = (error: Error): void => rejectListen(error);
        setup.server.once("error", failed);
        setup.server.listen(port, hostname, () => {
          setup.server.off("error", failed);
          resolveListen();
        });
      });
    } catch (cause) {
      await writerLease.release();
      throw cause;
    }
    console.log(`[polyth] setup server on ${origin}  data=${dataDir}`);

    let shutdown: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      if (!shutdown) {
        shutdown = setup.shutdown()
          .then(() => writerLease.release())
          .finally(closeAuthority);
      }
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
      issueSetupClaim() {
        const authority = security;
        if (!authority) {
          throw Object.assign(new Error("Setup authority is unavailable"), { code: "setup-unavailable" });
        }
        return authority.issueSetupClaim();
      },
      async shutdown() {
        process.off("SIGINT", sigint);
        process.off("SIGTERM", sigterm);
        await stop();
      },
    };
  } catch (cause) {
    closeAuthority();
    await writerLease.release().catch(() => undefined);
    throw cause;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void boot();
}
