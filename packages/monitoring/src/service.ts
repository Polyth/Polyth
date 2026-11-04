import { platform } from "node:os";
import type { Project, RouteHandler, SpaceContext, ToolExecutionContext } from "@polyth/contracts";
import { requireLocalTunnelAdmin, roleAtLeast } from "@polyth/contracts";
import { hasInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";
import { serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import type { SshService } from "@polyth/ssh";
import {
  diskPercent, HISTORY_RANGES, loadRatio, memoryPercent, worstDisk,
  type HistoryRange, type HostMetrics, type LogCandidate, type LogTail, type MetricHistory, type MonitoringHost, type MonitoringOperation, type MonitoringPolicy,
  type MonitoringIncident, type MonitoringSnapshot, type ProcessGroup, type ProcessSnapshot, type ServiceHealth,
} from "./contracts.ts";
import {
  boundedTail, discoverHostLogs, discoverLocalLogs, journalArgs, journalCandidates, journalSourceCommand, localHostLogTail, localLogTail, localMetrics, localProcesses,
  localServices, parseRemoteFile, parseRemoteHostLogs, parseRemoteMetrics, parseRemoteProcesses, parseServices, REMOTE_HOST_LOGS_COMMAND, REMOTE_METRICS_COMMAND,
  REMOTE_PROCESSES_COMMAND, remoteFileCommand, runLocal, serviceCommand,
} from "./collect.ts";
import { historyStore, machineIdOf, type HistoryStore } from "./history.ts";
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
  /** Every process on a local project's host is the Polyth server's, across all Spaces. */
  const mayReadProcesses = (project: Project, instanceOwner: boolean): boolean => !!project.remote || (instanceOwner && platform() === "linux");
  const describe = (project: Project, space?: SpaceContext, instanceOwner = false): MonitoringHost => ({ projectId: project.id, name: project.name,
    kind: project.remote ? "ssh" : "local", supported: host.deployment !== "multi-tenant-sandboxed",
    fileTailsAvailable: !project.remote && platform() === "linux", hostLogsAvailable: !!project.remote || platform() === "linux", canEditPolicy: !!space && roleAtLeast(space.role, "admin"),
    machineId: machineIdOf(project), processesAvailable: mayReadProcesses(project, instanceOwner) });
  const histories = new Map<string, HistoryStore>();
  const historyFor = (space: SpaceContext): HistoryStore => {
    let store = histories.get(space.spaceId);
    if (!store) { store = historyStore(host.spaceStorage(space)); histories.set(space.spaceId, store); }
    return store;
  };
  const flushHistories = () => {
    for (const store of histories.values()) {
      try { store.flush(Date.now()); } catch (error) { console.warn("[monitoring] history not saved", error instanceof Error ? error.message : error); }
    }
  };
  /** A chart is never worth failing a reading for. */
  const record = (space: SpaceContext, machineId: string, metrics: HostMetrics) => {
    try { historyFor(space).record(machineId, metrics, Date.now()); }
    catch (error) { console.warn("[monitoring] history not recorded", error instanceof Error ? error.message : error); }
  };
  /** Two samples take seconds: viewers of one machine share the sample under way. */
  const processReads = new Map<string, Promise<ProcessGroup[]>>();
  const processesOf = (space: SpaceContext, project: Project): Promise<ProcessGroup[]> => {
    const key = `${space.spaceId}:${machineIdOf(project)}`;
    let read = processReads.get(key);
    if (!read) {
      read = (project.remote ? remoteExec(project, REMOTE_PROCESSES_COMMAND).then(parseRemoteProcesses) : localProcesses())
        .finally(() => { processReads.delete(key); });
      processReads.set(key, read);
    }
    return read;
  };
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
    disable() { enabled = false; generation++; flushHistories(); histories.clear(); },
    async hosts(space: SpaceContext, opts: { instanceOwner?: boolean } = {}): Promise<MonitoringHost[]> {
      if (!enabled) throw failure("unavailable", "Monitoring is disabled");
      const epoch = generation;
      const projects = await host.forSpace(space).projects.list();
      current(epoch);
      return projects.map((project) => describe(project, space, opts.instanceOwner === true));
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
        const access = (value ?? {}) as { agentAccess?: { processes?: unknown } };
        const hostWide = added(input.logPaths, policy.logPaths).some((item) => validHostLogPath(item) || validJournalSource(item))
          || added(input.serviceUnits, policy.serviceUnits).length > 0
          || (access.agentAccess?.processes === true && !policy.agentAccess.processes);
        if (hostWide) throw failure("forbidden", "Only the instance owner can approve this server's journals, services, process names or host log files");
      }
      return policyStore(host.spaceStorage(space)).put(projectId, value, expectedRevision);
    },
    async snapshot(space: SpaceContext, projectId: string): Promise<MonitoringSnapshot> {
      const { epoch, project, policy } = await prepare(space, projectId);
      const metrics = project.remote ? parseRemoteMetrics(await remoteExec(project, REMOTE_METRICS_COMMAND)) : await localMetrics();
      const services = await collectServices(project, policy);
      current(epoch);
      const warnings: MonitoringSnapshot["warnings"] = [];
      if (memoryPercent(metrics) >= policy.memoryWarningPercent) warnings.push("memory");
      if (loadRatio(metrics) >= policy.loadWarningRatio) warnings.push("load");
      const fullest = worstDisk(metrics);
      if (fullest && diskPercent(fullest) >= policy.diskWarningPercent) warnings.push("disk");
      if (services.some((s) => s.state !== "active")) warnings.push("service");
      record(space, machineIdOf(project), metrics);
      return { host: describe(project), sampledAt: Date.now(), metrics, services, warnings,
        servicesAvailable: metrics.platform === "linux" };
    },
    /** The server's own reading, recorded for a Space without probing anything remote. */
    recordLocal(spaceId: string, metrics: HostMetrics): void {
      try { record(host.systemSpaceContext(spaceId), "local", metrics); }
      catch (error) { console.warn("[monitoring] history not recorded", error instanceof Error ? error.message : error); }
    },
    async history(space: SpaceContext, projectId: string, range: unknown): Promise<MetricHistory> {
      const { project } = await prepare(space, projectId);
      if (typeof range !== "string" || !Object.hasOwn(HISTORY_RANGES, range)) throw failure("invalid-input", "Choose a history range: 1h, 24h or 7d");
      return historyFor(space).read(machineIdOf(project), range as HistoryRange, Date.now());
    },
    async processes(space: SpaceContext, projectId: string, opts: { instanceOwner: boolean }): Promise<ProcessSnapshot> {
      const { epoch, project } = await prepare(space, projectId);
      if (!mayReadProcesses(project, opts.instanceOwner)) throw failure("forbidden", "Only the instance owner can read this server's process names");
      const groups = await processesOf(space, project);
      current(epoch);
      return { sampledAt: Date.now(), groups };
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
      if (action !== "metrics" && action !== "services" && action !== "logs" && action !== "processes" && action !== "history") throw failure("invalid-input", "Unknown Monitoring action");
      // History is older metrics: it needs the same grant, not a new one.
      const operation: MonitoringOperation = action === "history" ? "metrics" : action;
      const { space, epoch, project, policy } = await access(ctx, operation);
      let result: unknown;
      if (action === "history") {
        result = await this.history(space, ctx.projectId, input.range ?? "1h");
      } else if (action === "processes") {
        result = { sampledAt: Date.now(), groups: await processesOf(space, project) };
      } else if (action === "metrics") {
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
      requireAgentAccess(policyStore(host.spaceStorage(space)).get(ctx.projectId), operation);
      current(epoch);
      ctx.signal?.throwIfAborted();
      return result;
    },
  };
}
export type MonitoringService = ReturnType<typeof createMonitoringService>;

/** What the chat routes need from the alert loop, which owns incident state. */
export interface MonitoringIncidents {
  incident(space: SpaceContext, projectId: string): Promise<MonitoringIncident | null>;
  ask(space: SpaceContext, projectId: string): Promise<MonitoringIncident>;
}

export function monitoringRoutes(service: MonitoringService, incidents?: MonitoringIncidents): RouteHandler {
  return async (rc) => {
    if (!rc.path.startsWith("/api/monitoring/")) return false;
    const projectId = rc.url.searchParams.get("projectId") ?? "";
    if (rc.method === "GET") {
      if (rc.path === "/api/monitoring/hosts") rc.json(200, { items: await service.hosts(rc.space, { instanceOwner: hasInstanceOwnerAuthority(rc) }) });
      else if (rc.path === "/api/monitoring/policy") rc.json(200, await service.policy(rc.space, projectId));
      else if (rc.path === "/api/monitoring/snapshot") rc.json(200, await service.snapshot(rc.space, projectId));
      else if (rc.path === "/api/monitoring/history") rc.json(200, await service.history(rc.space, projectId, rc.url.searchParams.get("range")));
      else if (rc.path === "/api/monitoring/processes") rc.json(200, await service.processes(rc.space, projectId, { instanceOwner: hasInstanceOwnerAuthority(rc) }));
      else if (rc.path === "/api/monitoring/incident" && incidents) {
        await service.policy(rc.space, projectId);
        rc.json(200, { incident: await incidents.incident(rc.space, projectId) });
      }
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
    if (rc.path === "/api/monitoring/ask" && rc.method === "POST" && incidents) {
      // A person's request: an agent or a limited paired device cannot start chats here.
      requireLocalTunnelAdmin(rc, { allowInternalServices: [] });
      rc.json(200, await incidents.ask(rc.space, projectId));
      return true;
    }
    return false;
  };
}
