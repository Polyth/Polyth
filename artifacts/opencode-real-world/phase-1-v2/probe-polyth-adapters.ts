import { writeFile } from "node:fs/promises";
import type {
  OpenCodeTransport,
  ProtocolAdapter,
  RuntimeEndpoint,
  RuntimeSessionBinding,
} from "@polyth/contracts";
import {
  createOpenCodeTransport,
  createProtocolAdapter,
  type ProtocolSelection,
} from "@polyth/backend-opencode";

const baseUrl = process.env.OPENCODE_URL ?? "http://127.0.0.1:45126";
const directory = process.env.PROBE_DIRECTORY
  ?? "/tmp/polyth-oc-phase1-v2/project";
const output = process.env.PROBE_OUTPUT
  ?? "logs/opencode-real-world/phase-1-v2/polyth-adapter-matrix.json";

interface TraceEntry {
  kind: "query" | "mutation" | "stream";
  method?: string;
  path: string;
  status?: number;
  result?: string;
}

const endpoint: RuntimeEndpoint = {
  authorityId: "real-opencode-v2-1.18.18",
  continuity: "generation-only",
  generation: 1,
  url: baseUrl,
  location: { directory },
  control: { kind: "borrowed", source: "external" },
  config: { kind: "read-only" },
  authentication: { kind: "none" },
};

const binding: RuntimeSessionBinding = {
  canonicalSessionId: "canonical-phase1-v2",
  backendSessionId: "ses_phase1v2_001",
  authorityId: endpoint.authorityId,
  generation: endpoint.generation,
  continuity: endpoint.continuity,
  location: endpoint.location,
};

const errorShape = (error: unknown) => ({
  error: error instanceof Error ? error.message : String(error),
  code: typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined,
});

const capture = async (operation: () => unknown | Promise<unknown>) => {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, ...errorShape(error) };
  }
};

const exercise = async (protocolSelection: ProtocolSelection) => {
  const trace: TraceEntry[] = [];
  const transport = createOpenCodeTransport({
    baseUrl,
    directory,
    queryAttempts: 1,
  });
  const traced: OpenCodeTransport = {
    async query<T>(request: Parameters<OpenCodeTransport["query"]>[0]): Promise<T> {
      const result = await transport.query<T>(request);
      const response = result as { status?: number };
      trace.push({
        kind: "query",
        method: request.method,
        path: request.path,
        ...(typeof response?.status === "number" ? { status: response.status } : {}),
      });
      return result;
    },
    async mutate<T>(request: Parameters<OpenCodeTransport["mutate"]>[0]) {
      const result = await transport.mutate<T>(request);
      trace.push({
        kind: "mutation",
        method: request.method,
        path: request.path,
        result: result.kind,
        ...(result.kind === "response" ? { status: result.status } : {}),
      });
      return result;
    },
    async stream(request: Parameters<OpenCodeTransport["stream"]>[0]) {
      trace.push({ kind: "stream", path: request.path });
      return transport.stream(request);
    },
  };

  const adapter: ProtocolAdapter = await createProtocolAdapter({
    protocol: protocolSelection,
    transport: traced,
    endpoint,
  });
  const networkCallsAfterSelection = trace.length;
  const targetWithoutBackend = { ...binding, backendSessionId: undefined };
  const target = {
    ...targetWithoutBackend,
    canonicalSessionId: "canonical-phase1-v2-child",
  };

  const operations = {
    capabilities: await capture(() => adapter.capabilities()),
    models: await capture(() => adapter.models()),
    agents: await capture(() => adapter.agents()),
    sessions: await capture(() => adapter.sessions()),
    history: await capture(() => adapter.history(binding)),
    eventStreamPath: await capture(() => adapter.eventStreamPath()),
    create: await capture(() =>
      adapter.ensureSession(targetWithoutBackend, "operation-v2-create", "V2 probe")
    ),
    reset: await capture(() =>
      adapter.resetSession(binding, "V2 reset", "operation-v2-reset")
    ),
    fork: await capture(() =>
      adapter.branchSession({
        source: binding,
        target,
        history: [],
      }, "operation-v2-fork")
    ),
    prompt: await capture(() =>
      adapter.submit({
        session: binding,
        text: "This must not reach OpenCode",
      }, "operation-v2-prompt")
    ),
    steer: await capture(() =>
      adapter.steer({
        session: binding,
        text: "This must not reach OpenCode",
      }, "operation-v2-steer")
    ),
    abort: await capture(() => adapter.abort(binding, "operation-v2-abort")),
    delete: await capture(() =>
      adapter.deleteSession(binding, "operation-v2-delete")
    ),
    permissionReply: await capture(() =>
      adapter.replyPermission(
        binding,
        "per_phase1v2",
        "once",
        "operation-v2-permission",
      )
    ),
    questionReply: await capture(() =>
      adapter.replyQuestion(
        binding,
        "que_phase1v2",
        { answers: [["yes"]] },
        "operation-v2-question",
      )
    ),
    reconcile: await capture(() =>
      adapter.reconcile({
        ...binding,
        reconciliationOrdinal: 1,
      })
    ),
  };

  return {
    requested: protocolSelection,
    selected: adapter.protocol,
    operations,
    networkCallsAfterSelection,
    networkCallsAfterOperations: trace.length,
    postSelectionNetworkCalls: trace.slice(networkCallsAfterSelection),
    trace,
  };
};

const result = {
  capturedAt: new Date().toISOString(),
  openCode: { version: "1.18.18", baseUrl },
  runs: [
    await exercise("auto"),
    await exercise("v2"),
  ],
};

await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
