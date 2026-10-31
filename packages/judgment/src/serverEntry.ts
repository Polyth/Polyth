import { join } from "node:path";
import { localOnlyRemoteAccess, SERVER_RUNTIME_CATALOG, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import type { ModelDescriptor } from "@polyth/contracts";
import { AGENT_ENGINE_METADATA, createAgentJudgmentEngine, SMALL_MODEL_ID, SMALL_MODEL_PROVIDER, type AgentEngineOptions } from "./agentEngine.ts";
import { createJudgmentRuntime } from "./runtime.ts";
import { createJudgmentConcurrency } from "./concurrency.ts";
import { JudgmentExecutionError } from "./errors.ts";
import { JUDGMENT_SERVICE, type JudgmentEngineContribution, type JudgmentServerContext, type JudgmentService } from "./server.ts";
import { readSettings, writeSettings } from "./settingsStore.ts";
import { resolveTarget } from "./config.ts";
import { record } from "./validation.ts";
import type { JudgmentConfig, JudgmentRuntime } from "./types.ts";
import { resolveUseState, validateUseConfigAgainst, validateUseDescriptor, type JudgmentUseDescriptor } from "./uses.ts";
import { noul } from "./questions.ts";
import type { JudgmentCheckResult, JudgmentProviderOption, JudgmentSettingsSnapshot } from "./settings.ts";

const AGENT_FAILURE: Record<string, ConstructorParameters<typeof JudgmentExecutionError>[0]> = {
  unsupported: "provider-unavailable", unavailable: "provider-unavailable", "invalid-model": "model-unavailable",
  "model-unavailable": "model-unavailable", timeout: "timeout",
};

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let enabled = false;
  const engines = new Map<string, { contribution: JudgmentEngineContribution; lifetime: AbortController }>();
  const runs = new Map<JudgmentRuntime, JudgmentServerContext>();
  const uses = new Map<string, JudgmentUseDescriptor>();
  const sortedUses = () => [...uses.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
  // Shared across projects/runs in one Space: creating another runtime cannot bypass concurrency.
  const pools = new Map<string, ReturnType<typeof createJudgmentConcurrency>>();
  const projectPools = new Map<string, ReturnType<typeof createJudgmentConcurrency>>();
  const file = (ctx: JudgmentServerContext) => join(host.spaceStorage(ctx.space).packageDir("judgment"), "settings.json");
  const validateContext = async (ctx: JudgmentServerContext) => {
    if (!ctx.projectId || !await host.forSpace(ctx.space).projects.get(ctx.projectId)) {
      throw Object.assign(new Error("Project not found"), { code: "not-found" });
    }
  };
  const selected = (ctx: JudgmentServerContext) => {
    const settings = readSettings(file(ctx));
    const all = [...engines.values()].map((entry) => entry.contribution).sort((a, b) => a.metadata.id.localeCompare(b.metadata.id));
    const target = resolveTarget({ defaults: { engineId: all.find((e) => e.metadata.recommended)?.metadata.id ?? all[0]?.metadata.id },
      global: settings.global, project: settings.projects[ctx.projectId], scope: "settings.preview.v1" });
    return { settings, all, target, engine: engines.get(target.engineId ?? "")?.contribution };
  };
  const snapshot = (ctx: JudgmentServerContext): JudgmentSettingsSnapshot => {
    const { settings, all, target, engine } = selected(ctx);
    const capabilities = engine?.create(ctx).capabilities();
    return { revision: settings.revision, global: settings.global, project: settings.projects[ctx.projectId],
      engines: all.map((entry) => entry.metadata), engineId: target.engineId,
      defaultTarget: engine ? { engineId: engine.metadata.id, ...capabilities?.defaults } : undefined,
      ...(capabilities?.defaultModels ? { defaultModels: { ...capabilities.defaultModels } } : {}),
      providers: engine?.catalog(ctx) ?? [], engineSettings: engine?.settings?.(ctx), uses: sortedUses() };
  };
  const providerId = (body: unknown) => {
    if (!record(body) || (body.providerId !== undefined && (typeof body.providerId !== "string" || !body.providerId.trim() || body.providerId.length > 200))) {
      throw Object.assign(new Error("Invalid Judgment provider"), { code: "invalid-input" });
    }
    return body.providerId as string | undefined;
  };
  const service: JudgmentService = {
    registerEngine(contribution) {
      const id = contribution.metadata.id;
      if (engines.has(id)) throw new Error("Duplicate Judgment engine");
      const lifetime = new AbortController();
      engines.set(id, { contribution, lifetime });
      return () => { lifetime.abort(); if (engines.get(id)?.contribution === contribution) engines.delete(id); };
    },
    registerUse(descriptor) {
      validateUseDescriptor(descriptor);
      if (uses.has(descriptor.id)) throw new Error("Duplicate Judgment use");
      const frozen = structuredClone(descriptor);
      uses.set(descriptor.id, frozen);
      return () => { if (uses.get(descriptor.id) === frozen) uses.delete(descriptor.id); };
    },
    async resolveUse(ctx, useId) {
      await validateContext(ctx);
      const settings = readSettings(file(ctx));
      return resolveUseState(uses.get(useId), useId, settings.global, settings.projects[ctx.projectId], enabled);
    },
    async createRun(ctx, options = {}) {
      await validateContext(ctx);
      const settings = readSettings(file(ctx));
      const key = ctx.space.spaceId;
      let pool = pools.get(key);
      const spaceLimit = settings.global.limits?.maxConcurrentCalls ?? 4;
      if (!pool) { pool = createJudgmentConcurrency(spaceLimit); pools.set(key, pool); }
      else pool.setLimit(spaceLimit);
      const projectKey = JSON.stringify([key, ctx.projectId]);
      let projectPool = projectPools.get(projectKey);
      const projectLimit = settings.projects[ctx.projectId]?.limits?.maxConcurrentCalls ?? spaceLimit;
      if (!projectPool) { projectPool = createJudgmentConcurrency(projectLimit); projectPools.set(projectKey, projectPool); }
      else projectPool.setLimit(projectLimit);
      const sharedConcurrency = { async acquire(signal: AbortSignal) {
        const releaseSpace = await pool!.acquire(signal);
        try {
          const releaseProject = await projectPool!.acquire(signal);
          return () => { releaseProject(); releaseSpace(); };
        } catch (error) { releaseSpace(); throw error; }
      } };
      const adapters = [...engines.values()].map(({ contribution, lifetime }) => {
        const adapter = contribution.create(ctx);
        return { ...adapter, async judge(request: Parameters<typeof adapter.judge>[0], context: Parameters<typeof adapter.judge>[1]) {
          if (lifetime.signal.aborted) throw new JudgmentExecutionError("engine-unavailable");
          return adapter.judge(request, { ...context, signal: AbortSignal.any([context.signal, lifetime.signal]) });
        } };
      });
      const runtime = createJudgmentRuntime({ engines: adapters, global: settings.global,
        project: { ...settings.projects[ctx.projectId], ...(!enabled ? { enabled: false } : {}) },
        budget: options.budget, concurrency: sharedConcurrency, observe: options.observe });
      const run: JudgmentRuntime = { judge: (request) => runtime.judge({ ...request, metadata: { ...request.metadata, projectId: ctx.projectId } }),
        dispose() { runtime.dispose(); runs.delete(run); } };
      runs.set(run, ctx);
      return run;
    },
  };
  host.services.provide(JUDGMENT_SERVICE, service);

  // Agent model engine: the person's own harness models through the host's
  // tool-less small-model completion. No key, no Credential Vault.
  let catalog: ModelDescriptor[] | undefined;
  let unregisterAgent: (() => void) | undefined;
  const readCatalog = async () => {
    const models = await host.services.get(SERVER_RUNTIME_CATALOG)?.models({ maxAgeMs: 60_000 }).catch(() => undefined);
    if (models) catalog = models.filter((model) => model.harnessId && model.connected !== false);
  };
  const harnessModels = () => {
    const byHarness = new Map<string, ModelDescriptor[]>();
    for (const model of catalog ?? []) byHarness.set(model.harnessId!, [...byHarness.get(model.harnessId!) ?? [], model]);
    return [...byHarness.entries()].sort(([a], [b]) => a.localeCompare(b));
  };
  const smallModelOf = (ctx: JudgmentServerContext) => host.smallModel?.(ctx.space.userId);
  const agentOptions = (ctx: JudgmentServerContext): AgentEngineOptions => ({
    smallModel: () => smallModelOf(ctx),
    harnesses: () => catalog ? harnessModels().map(([harnessId]) => harnessId) : undefined,
    async complete({ harnessId, model, ...input }) {
      // Revalidate at use time: a run never outlives the project it was created for.
      const project = await host.forSpace(ctx.space).projects.get(ctx.projectId);
      if (!project) throw new JudgmentExecutionError("provider-unavailable");
      try {
        const runtime = await host.runtimes.forProject(project.id, project.path, harnessId);
        // Direct only: the evidence is untrusted text and must never reach an agent turn with tools.
        const result = await host.smallModelComplete(runtime, { cwd: project.path, model, purpose: "judgment", requireDirect: true, ...input });
        return { text: result.text, providerID: result.providerID, modelID: result.modelID };
      } catch (error) {
        if (input.signal.aborted || error instanceof JudgmentExecutionError) throw error;
        throw new JudgmentExecutionError(AGENT_FAILURE[String((error as { code?: unknown })?.code)] ?? "provider-error");
      }
    },
  });
  const agentCatalog = (ctx: JudgmentServerContext): JudgmentProviderOption[] => {
    const small = smallModelOf(ctx);
    const smallName = small ? `${small.harnessId ? `${small.harnessId} · ` : ""}${small.providerID}/${small.modelID}` : "Small Model";
    return [{ provider: { ...SMALL_MODEL_PROVIDER }, status: small ? "available" : "unavailable", credential: "none", automatic: true, harness: true,
      description: small ? `${smallName}, as set in Settings → Sessions → Small Model.` : "Choose a Small Model in Settings → Sessions first.",
      models: [{ providerID: SMALL_MODEL_PROVIDER.id, providerName: SMALL_MODEL_PROVIDER.name, modelID: SMALL_MODEL_ID, name: smallName, connected: true, capabilities: ["input:text"] }] },
    ...harnessModels().map(([harnessId, models]): JudgmentProviderOption => ({
      provider: { id: harnessId, name: harnessId }, status: "available", credential: "none", harness: true,
      description: `A ${harnessId} model, billed to that harness's account.`,
      models: models.map((model) => ({ providerID: harnessId, providerName: model.providerName ?? model.providerID,
        modelID: `${model.providerID}/${model.modelID}`, name: model.name, connected: true, capabilities: ["input:text"] })),
    }))];
  };
  const enableAgent = () => {
    if (unregisterAgent || !host.runtimes?.forProject || !host.smallModelComplete) return;
    void readCatalog();
    unregisterAgent = service.registerEngine({
      metadata: AGENT_ENGINE_METADATA,
      create: (ctx) => createAgentJudgmentEngine(agentOptions(ctx)),
      catalog: agentCatalog,
      async refresh() { await readCatalog(); },
    });
  };

  return {
    remoteAccess: localOnlyRemoteAccess(["judgment"]),
    async routes(rc) {
      if (!rc.path.startsWith("/api/judgment/")) return false;
      const ctx: JudgmentServerContext = { space: rc.space, projectId: rc.url.searchParams.get("projectId") ?? "" };
      await validateContext(ctx);
      if (rc.path === "/api/judgment/settings" && rc.method === "GET") { rc.json(200, snapshot(ctx)); return true; }
      if (rc.path === "/api/judgment/settings" && rc.method === "PUT") {
        const body = await rc.body();
        if (!record(body) || !["global", "project"].includes(body.level as string) || !Number.isSafeInteger(body.revision)) {
          throw Object.assign(new Error("Invalid Judgment settings"), { code: "invalid-input" });
        }
        // Values for a registered use must fit its descriptor; a disabled package's stored values are kept as they are.
        for (const [id, use] of Object.entries((record(body.config) ? (body.config as Partial<JudgmentConfig>).uses : undefined) ?? {})) {
          const descriptor = uses.get(id);
          if (descriptor && record(use)) validateUseConfigAgainst(descriptor, use);
        }
        writeSettings(file(ctx), body.config, body.revision as number, body.level === "project" ? ctx.projectId : undefined);
        for (const [run, owner] of runs) {
          if (owner.space.spaceId === ctx.space.spaceId && (body.level === "global" || owner.projectId === ctx.projectId)) run.dispose();
        }
        rc.json(200, snapshot(ctx)); return true;
      }
      if (rc.path === "/api/judgment/credential" && rc.method === "PUT") {
        const body = await rc.body();
        if (!record(body) || Object.keys(body).some((key) => key !== "secretHandle" && key !== "providerId")
          || (body.secretHandle !== undefined && (typeof body.secretHandle !== "string" || body.secretHandle.length > 128))) {
          throw Object.assign(new Error("Select a Credential Vault handle"), { code: "invalid-input" });
        }
        const engine = selected(ctx).engine;
        if (!engine?.configure) throw Object.assign(new Error("Judgment engine unavailable"), { code: "unavailable" });
        await engine.configure(ctx, { providerId: providerId(body), ...(body.secretHandle ? { secretHandle: body.secretHandle as string } : {}) });
        for (const [run, owner] of runs) {
          if (owner.space.spaceId === ctx.space.spaceId && owner.projectId === ctx.projectId) run.dispose();
        }
        rc.json(200, snapshot(ctx)); return true;
      }
      if (rc.path === "/api/judgment/models/refresh" && rc.method === "POST") {
        const entry = engines.get(selected(ctx).target.engineId ?? "");
        if (!entry?.contribution.refresh) throw Object.assign(new Error("Judgment engine unavailable"), { code: "unavailable" });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        const provider = providerId(await rc.body() ?? {});
        try { await entry.contribution.refresh(ctx, AbortSignal.any([controller.signal, entry.lifetime.signal]), provider); }
        finally { clearTimeout(timer); }
        rc.json(200, snapshot(ctx)); return true;
      }
      if (rc.path === "/api/judgment/check" && rc.method === "POST") {
        // One real call through the effective target, without retries: proof that it answers, not that it always will.
        const run = await service.createRun(ctx);
        try {
          const result = await run.judge({ scope: "settings.check.v1", state: "Polyth Judgment connectivity check.",
            questions: { reachable: noul("Is this text a connectivity check?") }, budget: { maxCalls: 1 } });
          const check: JudgmentCheckResult = result.ok
            ? { ok: true, engineId: result.engine.id, providerId: result.model?.providerId, modelId: result.model?.modelId, durationMs: result.timing.durationMs, checkedAt: Date.now() }
            : { ok: false, reason: result.reason, durationMs: result.timing.durationMs, checkedAt: Date.now() };
          rc.json(200, check); return true;
        } finally { run.dispose(); }
      }
      return false;
    },
    onEnable() { enabled = true; enableAgent(); },
    onDisable() {
      enabled = false;
      unregisterAgent?.(); unregisterAgent = undefined;
      for (const run of runs.keys()) run.dispose();
    },
  };
}
