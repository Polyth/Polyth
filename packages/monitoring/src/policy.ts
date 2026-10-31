import { readFileSync } from "node:fs";
import { atomicWriteSync } from "@polyth/plugins";
import type { SpaceStorage } from "@polyth/contracts";
import type { MonitoringOperation, MonitoringPolicy } from "./contracts.ts";

export const failure = (code: string, message: string): Error => Object.assign(new Error(message), { code });
export const defaultPolicy = (): MonitoringPolicy => ({
  revision: 0,
  agentAccess: { metrics: false, services: false, logs: false },
  serviceUnits: [], logPaths: [], memoryWarningPercent: 85, loadWarningRatio: 1,
});
export const validUnit = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,119}\.service$/.test(value);
export const validLogPath = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 240 && !value.startsWith("/")
  && !/[\\\x00-\x1f\x7f]/.test(value) && value.split("/").every((part) => !!part && part !== "." && part !== ".." && !part.startsWith("."))
  && /\.log$/.test(value);
/**
 * Absolute host log file: anything under `/var/log/`, or any absolute `.log`
 * file. A conservative character set keeps it safe to quote for SSH; `.`/`..`
 * segments and pseudo filesystems are rejected. Collectors validate the
 * resolved target again, so a symlink cannot redirect to another file.
 */
export const validHostLogPath = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 240 && /^\/[A-Za-z0-9._@+\/-]+$/.test(value)
  && value.slice(1).split("/").every((part) => !!part && part !== "." && part !== "..")
  && !/^\/(proc|sys|dev|run)\//.test(value)
  && (value.startsWith("/var/log/") || /\.log$/.test(value));
/** `journal` (whole system journal), `kernel` or `journal:<unit>.service`. */
export const validJournalSource = (value: unknown): value is string =>
  value === "journal" || value === "kernel" || (typeof value === "string" && value.startsWith("journal:") && validUnit(value.slice("journal:".length)));
export const validLogSource = (value: unknown): value is string =>
  validLogPath(value) || validHostLogPath(value) || validJournalSource(value);
export const LOG_SOURCE_LIMIT = 24;

export function parsePolicy(value: unknown, revision: number): MonitoringPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("invalid-input", "Monitoring policy must be an object");
  const input = value as Record<string, unknown>;
  const access = input.agentAccess as Record<string, unknown> | undefined;
  if (!access || ["metrics", "services", "logs"].some((op) => typeof access[op] !== "boolean")) {
    throw failure("invalid-input", "Explicit agent permissions are required");
  }
  const list = (key: string, valid: (value: unknown) => value is string, limit = 12): string[] => {
    const values = input[key];
    if (!Array.isArray(values) || values.length > limit || !values.every(valid)) throw failure("invalid-input", `Invalid ${key}: use up to ${limit} approved entries`);
    return [...new Set(values)];
  };
  const memory = input.memoryWarningPercent;
  const load = input.loadWarningRatio;
  if (typeof memory !== "number" || !Number.isFinite(memory) || memory < 1 || memory > 100
    || typeof load !== "number" || !Number.isFinite(load) || load < 0.1 || load > 10) {
    throw failure("invalid-input", "Invalid warning thresholds");
  }
  return {
    revision,
    agentAccess: { metrics: access.metrics as boolean, services: access.services as boolean, logs: access.logs as boolean },
    serviceUnits: list("serviceUnits", validUnit), logPaths: list("logPaths", validLogSource, LOG_SOURCE_LIMIT),
    memoryWarningPercent: memory, loadWarningRatio: load,
  };
}

/** No process-wide tenant cache. Synchronous compare/write prevents lost updates. */
export function policyStore(storage: SpaceStorage) {
  storage.packageDir("monitoring");
  const path = () => storage.path("packages/monitoring/policies.json");
  const read = (): Record<string, MonitoringPolicy> => {
    try {
      const value: unknown = JSON.parse(readFileSync(path(), "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("unavailable", "Monitoring policy storage is invalid");
      return value as Record<string, MonitoringPolicy>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  };
  const get = (projectId: string): MonitoringPolicy => {
    const records = read();
    if (!Object.hasOwn(records, projectId)) return defaultPolicy();
    const stored = records[projectId]!;
    if (!Number.isSafeInteger(stored.revision) || stored.revision < 1) throw failure("unavailable", "Monitoring policy revision is invalid");
    return parsePolicy(stored, stored.revision);
  };
  return {
    get,
    put(projectId: string, value: unknown, expectedRevision: unknown): MonitoringPolicy {
      const current = get(projectId);
      if (expectedRevision !== current.revision) throw failure("conflict", "Monitoring policy changed; reload before saving");
      const next = parsePolicy(value, current.revision + 1);
      const records = read();
      Object.defineProperty(records, projectId, { value: next, enumerable: true, configurable: true, writable: true });
      atomicWriteSync(path(), `${JSON.stringify(records, null, 2)}\n`);
      return next;
    },
  };
}

export function requireAgentAccess(policy: MonitoringPolicy, operation: MonitoringOperation): void {
  if (!policy.agentAccess[operation]) throw failure("forbidden", `Agent ${operation} access is disabled by Monitoring policy`);
}
