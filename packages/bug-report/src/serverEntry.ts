// Feedback from a page opened in a browser. The desktop shell captures and
// sends its own window's feedback; a browser has no shell, so this server sends
// it instead (src/sender.ts): `GET /api/bug-report/state` says whether it sends
// and what it adds, `POST /api/bug-report/send` takes the sheet's draft with the
// screenshot the page captured, `POST /api/bug-report/forget` erases what this
// server sent under its resettable pseudonym. Paired devices reach the routes
// only with full access (default-deny).
import { arch, platform } from "node:os";
import type { RouteHandler } from "@polyth/contracts";
import { isWorkstationEdition } from "@polyth/contracts/edition";
import { localOnlyRemoteAccess, packageDataDir, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { BUG_REPORT_CAPABILITY_ID } from "./index.ts";
import { createServerReporter, serverBugReportOrigin, type ServerReporter } from "./sender.ts";

export const BUG_REPORT_ROUTE_SCOPE = "bug-report";

export function bugReportRoutes(reporter: () => ServerReporter | null): RouteHandler {
  return async ({ path, method, json, body }) => {
    if (path === "/api/bug-report/state" && method === "GET") {
      const current = reporter();
      json(200, current?.state() ?? { available: false, queued: 0, base: null });
      return true;
    }
    if (path === "/api/bug-report/send" && method === "POST") {
      const current = reporter();
      if (!current) {
        json(503, { result: "unavailable" });
        return true;
      }
      let draft: unknown;
      try {
        draft = await body();
      } catch {
        json(400, { result: "invalid" });
        return true;
      }
      // The outcome is the answer; the sheet reads `result`, not the status.
      json(200, await current.send(draft));
      return true;
    }
    if (path === "/api/bug-report/forget" && method === "POST") {
      const current = reporter();
      json(200, current ? await current.forget() : { result: "unavailable" });
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let reporter: ServerReporter | null = null;
  return {
    remoteAccess: localOnlyRemoteAccess([BUG_REPORT_ROUTE_SCOPE]),
    routes: bugReportRoutes(() => reporter),
    onEnable() {
      if (reporter) return;
      const origin = serverBugReportOrigin({
        version: host.version,
        workstation: isWorkstationEdition(process.env),
        multiTenant: host.deployment === "multi-tenant-sandboxed",
        env: process.env,
      });
      if (!origin || !host.version) return;
      reporter = createServerReporter({
        dir: packageDataDir(host),
        origin,
        version: host.version,
        platform: platform(),
        arch: arch(),
        fetch: globalThis.fetch,
        log: (message, detail) => console.warn(`[${BUG_REPORT_CAPABILITY_ID}] ${message}`, detail ?? ""),
      });
      void reporter.flushOutbox();
    },
    onDisable() {
      reporter?.dispose();
      reporter = null;
    },
  };
}
