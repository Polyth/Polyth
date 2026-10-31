import { platform } from "node:os";
import type { Project, RouteHandler, SpaceContext, ToolExecutionContext } from "@polyth/contracts";
import { requireLocalTunnelAdmin, roleAtLeast } from "@polyth/contracts";
import { hasInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";
import { serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import type { SshService } from "@polyth/ssh";
import type { LogCandidate, LogTail, MonitoringHost, MonitoringOperation, MonitoringPolicy, MonitoringSnapshot, ServiceHealth } from "./contracts.ts";
import {
  boundedTail, discoverHostLogs, discoverLocalLogs, journalArgs, journalCandidates, journalSourceCommand, localHostLogTail, localLogTail, localMetrics,
  localServices, parseRemoteFile, parseRemoteHostLogs, parseRemoteMetrics, parseServices, REMOTE_HOST_LOGS_COMMAND, REMOTE_METRICS_COMMAND,
  remoteFileCommand, runLocal, serviceCommand,
} from "./collect.ts";
import { failure, policyStore, requireAgentAccess, validHostLogPath, validJournalSource, validLogPath } from "./policy.ts";

export function createMonitoringService(host: ServerPackageHost) {
  let enabled = false;
  let generation = 0;
  const admitted = () => {
    if (!enabled) throw failure("unavailable", "Monitoring is disabled");
    if (host.deployment === "multi-tenant-sandboxed") throw failure("forbidden", "Host monitoring is unavailable in sandboxed deployments");
    return generation;
  };
  const current = (epoch: number) => {
    if (!enabled || epoch !== generation) throw failure("unavailable", "Monitoring was disabled during the request");
  };
  const describe = (project: Project, space?: SpaceContext): MonitoringHost => ({ projectId: project.id, name: project.name,
    kind: project.remote ? "ssh" : "local", supported: host.deployment !== "multi-tenant-sandboxed",
    fileTailsAvailable: !project.remote && platform() === "linux", hostLogsAvailable: !!project.remote || platform() === "linux", canEditPolicy: !!space && roleAtLeast(space.role, "admin") });
  const projectFor = async (space: SpaceContext, projectId: string): Promise<Project> => {
    if (!projectId) throw failure("invalid-input", "projectId is required");
    const project = await host.forSpace(space).projects.get(projectId);
    if (!project) throw failure("not-found", "Monitoring project not found");
    return project;
  };
  const prepare = async (space: SpaceContext, projectId: string) => {
    const epoch = admitted();
    const project = await projectFor(space, projectId);
    current(epoch);
    return { epoch, project, policy: policyStore(host.spaceStorage(space)).get(projectId) };
  };
  const ssh = () => {
    const transport = host.services.get(serverServiceKey<SshService>("ssh"));
    if (!transport) throw failure("unavailable", "Enable SSH Remotes to monitor an SSH host");
    return transport;
  };
  const remoteExec = async (project: Project, command: string) => {
    // The caller has already resolved this project's Space. Never accept a
    // model/browser-supplied connection id or enumerate the global SSH store.
    const result = await ssh().exec(project.remote!.connectionId, command, { timeoutMs: 10_000 });
    if (result.code !== 0) throw failure("unavailable", "Host probe failed; check host access and required Linux tools");
    return result.stdout;
  };
  const collectServices = async (project: Project, policy: MonitoringPolicy): Promise<ServiceHealth[]> => {
    if (!policy.serviceUnits.length) return [];
    if (!project.remote) return platform() === "linux" ? localServices(policy.serviceUnits) : [];
    return parseServices(policy.serviceUnits, await remoteExec(project, serviceCommand(policy.serviceUnits)));
  };
  const access = async (ctx: ToolExecutionContext, operation?: MonitoringOperation) => {
    if (!ctx.spaceId || !ctx.sessionId || !ctx.projectId) throw failure("forbidden", "Monitoring requires a scoped canonical session");
    const space = host.systemSpaceContext(ctx.spaceId);
    const session = await host.forSpace(space).sessions.snapshot(ctx.sessionId);
    if (session.projectId !== ctx.projectId || session.spaceId !== space.spaceId) throw failure("not-found", "Monitoring session not found");
    const prepared = await prepare(space, ctx.projectId);
    if (operation) requireAgentAccess(prepared.policy, operation);
    ctx.signal?.throwIfAborted();
    return { space, ...prepared };
  };
  return {
    enable() { if (!enabled) { enabled = true; generation++; } },
    disable() { enabled = false; generation++; },
    async hosts(space: SpaceContext): Promise<MonitoringHost[]> {
      if (!enabled) throw failure("unavailable", "Monitoring is disabled");
      const epoch = generation;
      const projects = await host.forSpace(space).projects.list();
      current(epoch);
      return projects.map((project) => describe(project, space));
    },
    async policy(space: SpaceContext, projectId: string): Promise<MonitoringPolicy> {
      return (await prepare(space, projectId)).policy;
    },
    async putPolicy(space: SpaceContext, projectId: string, value: unknown, expectedRevision: unknown, opts: { instanceOwner?: boolean } = {}): Promise<MonitoringPolicy> {
      const { project, policy } = await prepare(space, projectId);
      if (!roleAtLeast(space.role, "admin")) throw failure("forbidden", "Only Space administrators can edit Monitoring access");
      // A local project's host is the Polyth server itself, shared by every
      // Space: only the instance owner may newly approve its journals, service
      // units or host files. Project files and SSH hosts stay Space-admin.
      if (!project.remote && opts.instanceOwner === false) {
        const input = (value ?? {}) as { logPaths?: unknown; serviceUnits?: unknown };
        const added = (list: unknown, old: string[]) => Array.isArray(list) ? list.filter((item) => typeof item === "string" && !old.includes(item)) : [];
        const hostWide = added(input.logPaths, policy.logPaths).some((item) => validHostLogPath(item) || validJournalSource(item))
          || added(input.serviceUnits, policy.serviceUnits).length > 0;
        if (hostWide) throw failure("forbidden", "Only the instance owner can approve this server's journals, services or host log files");
      }
      return policyStore(host.spaceStorage(space)).put(projectId, value, expectedRevision);
    },
    async snapshot(space: SpaceContext, projectId: string): Promise<MonitoringSnapshot> {
      const { epoch, project, policy } = await prepare(space, projectId);
      const metrics = project.remote ? parseRemoteMetrics(await remoteExec(project, REMOTE_METRICS_COMMAND)) : await localMetrics();
      const services = await collectServices(project, policy);
      current(epoch);
      const warnings: MonitoringSnapshot["warnings"] = [];
      if ((1 - metrics.memoryAvailable / metrics.memoryTotal) * 100 >= policy.memoryWarningPercent) warnings.push("memory");
      if (metrics.load[0] / metrics.cpuCount >= policy.loadWarningRatio) warnings.push("load");
      if (services.some((s) => s.state !== "active")) warnings.push("service");
      return { host: describe(project), sampledAt: Date.now(), metrics, services, warnings,
        servicesAvailable: metrics.platform === "linux" };
    },
    /** Approvable log sources for the policy editor; agents never get this list. */
    async logCandidates(space: SpaceContext, projectId: string): Promise<LogCandidate[]> {
      const { epoch, project } = await prepare(space, projectId);
      let items: LogCandidate[];
      // Host file suggestions are optional; journals stay offered when listing fails.
      if (project.remote) items = [...journalCandidates(), ...await remoteExec(project, REMOTE_HOST_LOGS_COMMAND).then(parseRemoteHostLogs, () => [])];
      else if (platform() !== "linux") items = [];
      else items = [...journalCandidates(), ...await discoverHostLogs(), ...await discoverLocalLogs(project.path)];
      current(epoch);
      return items;
    },
    async logs(space: SpaceContext, projectId: string, source: string): Promise<LogTail> {
      const { epoch, project, policy } = await prepare(space, projectId);
      // Service units are approved journal sources too, as before.
      const approved = policy.logPaths.includes(source)
        || (source.startsWith("journal:") && policy.serviceUnits.includes(source.slice("journal:".length)));
      if (!approved) throw failure("forbidden", "Log source is not approved");
      let result: LogTail;
      if (validJournalSource(source)) {
        result = boundedTail(project.remote ? await remoteExec(project, journalSourceCommand(source)) : await runLocal("journalctl", journalArgs(source)), source);
      } else if (validHostLogPath(source)) {
        result = project.remote ? parseRemoteFile(source, await remoteExec(project, remoteFileCommand(source))) : await localHostLogTail(source);
      } else if (validLogPath(source)) {
        if (project.remote) throw failure("unsupported", "Project file tails are local-only; approve an absolute host path on SSH hosts");
        result = await localLogTail(project.path, source);
      } else throw failure("invalid-input", "Invalid log source");
      current(epoch);
      return result;
    },
    async agentRead(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<unknown> {
      const action = input.action;
      if (action === "policy") {
        const { policy, project } = await access(ctx);
        return { policy, host: describe(project), fileTailsAvailable: !project.remote && platform() === "linux", readOnly: true };
      }
      if (action !== "metrics" && action !== "services" && action !== "logs") throw failure("invalid-input", "Unknown Monitoring action");
      const { space, epoch, project, policy } = await access(ctx, action);
      let result: unknown;
      if (action === "metrics") {
        const metrics = project.remote ? parseRemoteMetrics(await remoteExec(project, REMOTE_METRICS_COMMAND)) : await localMetrics();
        result = { host: describe(project), sampledAt: Date.now(), metrics };
      } else if (action === "services") {
        if (!project.remote && platform() !== "linux") throw failure("unsupported", "Service probes require Linux with systemd");
        result = { sampledAt: Date.now(), services: await collectServices(project, policy) };
      } else {
        if (typeof input.source !== "string") throw failure("invalid-input", "An approved log source is required");
        result = await this.logs(space, ctx.projectId, input.source);
      }
      // Revocation/disable while a probe is running must suppress its result.
      requireAgentAccess(policyStore(host.spaceStorage(space)).get(ctx.projectId), action);
      current(epoch);
      ctx.signal?.throwIfAborted();
      return result;
    },
  };
}
export type MonitoringService = ReturnType<typeof createMonitoringService>;

export function monitoringRoutes(service: MonitoringService): RouteHandler {
  return async (rc) => {
    if (!rc.path.startsWith("/api/monitoring/")) return false;
    const projectId = rc.url.searchParams.get("projectId") ?? "";
    if (rc.method === "GET") {
      if (rc.path === "/api/monitoring/hosts") rc.json(200, { items: await service.hosts(rc.space) });
      else if (rc.path === "/api/monitoring/policy") rc.json(200, await service.policy(rc.space, projectId));
      else if (rc.path === "/api/monitoring/snapshot") rc.json(200, await service.snapshot(rc.space, projectId));
      else if (rc.path === "/api/monitoring/log-candidates") rc.json(200, { items: await service.logCandidates(rc.space, projectId) });
      else if (rc.path === "/api/monitoring/logs") rc.json(200, await service.logs(rc.space, projectId, rc.url.searchParams.get("source") ?? ""));
      else return false;
      return true;
    }
    if (rc.path === "/api/monitoring/policy" && rc.method === "PUT") {
      // A package-tool agent or paired device cannot grant itself host access.
      requireLocalTunnelAdmin(rc);
      const input = await rc.body();
      rc.json(200, await service.putPolicy(rc.space, projectId, input.policy, input.expectedRevision, { instanceOwner: hasInstanceOwnerAuthority(rc) }));
      return true;
    }
    return false;
  };
}
