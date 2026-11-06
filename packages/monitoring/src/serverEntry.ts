import type { AgentCapabilityContributionRegistry, Disposable } from "@polyth/contracts";
import { localOnlyRemoteAccess, serverServiceKey, SESSION_PURPOSES, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { SYSTEM_ADMIN_RULES } from "./contracts.ts";
import { createMonitoringService, monitoringRoutes } from "./service.ts";
import { createMonitoringAlerts } from "./alerts.ts";
import { localMetrics } from "./collect.ts";
import { createHistorySampler } from "./history.ts";

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const service = createMonitoringService(host);
  const alerts = createMonitoringAlerts(host, service);
  const sampler = createHistorySampler(host, (spaceId, metrics) => service.recordLocal(spaceId, metrics), localMetrics);
  let registrations: Disposable[] = [];
  const dispose = () => {
    sampler.stop();
    alerts.stop();
    service.disable();
    registrations.toReversed().forEach((item) => item.dispose());
    registrations = [];
  };
  return {
    remoteAccess: localOnlyRemoteAccess(["monitoring"]),
    routes: monitoringRoutes(service, alerts),
    onEnable() {
      dispose();
      try {
        const purposes = host.services.get(SESSION_PURPOSES);
        if (purposes) registrations.push(purposes.register("sysadmin", () => SYSTEM_ADMIN_RULES.join("\n")));
        const registry = host.services.get(serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"));
        if (registry) {
          registrations.push(registry.register("monitoring", {
            descriptor: {
              id: "monitoring.monitoring_read", kind: "tool", owner: "monitoring", scope: "project", revision: "1",
              name: "monitoring_read", description: "Read the current project's Monitoring policy, host metrics (memory, load, disk, pressure), their recent history, process names with CPU and memory, approved service health or approved log tails (project/host files, system or kernel journal, service journals). Read-only; each diagnostic operation requires its own project policy grant. History needs the metrics grant.",
              inputSchema: { type: "object", additionalProperties: false, required: ["action"], properties: {
                action: { type: "string", enum: ["policy", "metrics", "history", "processes", "services", "logs"] },
                range: { type: "string", enum: ["1h", "24h", "7d"], description: "Time range for history. Defaults to 1h." },
                source: { type: "string", maxLength: 240, description: "An approved log source for logs: project .log path, absolute host file, journal, kernel or journal:<unit>.service. See policy.logPaths/serviceUnits." },
              } }, trust: "workspace", mutating: false,
            },
            execute: async (input, ctx) => ({ output: JSON.stringify(await service.agentRead(input, ctx)) }),
          }));
          registrations.push(registry.register("monitoring", {
            descriptor: { id: "monitoring.skill.system-administrator", kind: "skill", owner: "monitoring", scope: "project", revision: "1",
              name: "system-administrator", title: "System administrator", description: "Bounded host diagnostics with explicit project permissions.",
              instructions: SYSTEM_ADMIN_RULES.join("\n") },
          }));
        }
        service.enable();
        if (host.deployment !== "multi-tenant-sandboxed") { alerts.start(); sampler.start(); }
      } catch (error) { dispose(); throw error; }
    },
    onDisable: dispose,
  };
}
