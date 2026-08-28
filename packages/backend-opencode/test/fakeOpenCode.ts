/**
 * Shared real-socket OpenCode fault backend.
 *
 * Public API:
 * - `createFakeOpenCode()` starts a Node HTTP/SSE server on an ephemeral port.
 * - `fake.scriptHttp({ method, path, steps })` installs an ordered fault script.
 *   Use `httpFaults.acceptThenClose()`, `delayForever()`, `status()`,
 *   `malformedJson()`, `truncateBody()`, `connectionReset()`,
 *   `headersThenStall()`, or `success()`. The final step repeats.
 * - `fake.scriptSse(...scripts)` scripts each successive `/event` connection.
 *   Scripts can drop/duplicate event types, disconnect after event N, replay
 *   nothing on reconnect, reorder replay, or stay connected but silent.
 * - `fake.emitSse()` / `emitSseBatch()` publish events; `waitForRequest()`,
 *   `waitForCommit()`, `waitForSseConnections()`, and
 *   `waitForSseDisconnects()` are deterministic barriers.
 * - `fake.lifecycle` maintains sessions, pending permissions/questions,
 *   accepted messages, busy/finished turns, and incomplete turns after
 *   `hardDeath()`. Unscripted legacy routes expose that state.
 * - Set `applyLifecycle: true` on a committed HTTP fault to apply the normal
 *   route effect before the response fault. `fake.restart()` starts the same
 *   authoritative state on a new endpoint; pass `{ basicAuth }` to rotate
 *   credentials with the endpoint generation.
 * - `fake.close()` is graceful; `fake.crash()` abruptly closes sockets while
 *   retaining inspectable in-memory state.
 */
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface FakeBasicAuth {
  username: string;
  password: string;
}

export interface FakeOpenCodeOptions {
  basicAuth?: FakeBasicAuth;
}

export interface FakeRestartOptions {
  /** Omit to retain credentials, provide a value to rotate them, or use null
   * to replace an authenticated endpoint with an unauthenticated one. */
  basicAuth?: FakeBasicAuth | null;
}

export interface FakeBarrier {
  readonly reached: Promise<void>;
  wait(): Promise<void>;
  release(): void;
}

export const createFakeBarrier = (): FakeBarrier => {
  let reach!: () => void;
  let release!: () => void;
  let didReach = false;
  let didRelease = false;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    async wait(): Promise<void> {
      if (!didReach) {
        didReach = true;
        reach();
      }
      await released;
    },
    release(): void {
      if (didRelease) return;
      didRelease = true;
      release();
    },
  };
};

export interface FakeHttpCommitOptions {
  commit?: boolean;
  persisted?: unknown;
  /** Apply the normal route mutation before injecting the response fault. */
  applyLifecycle?: boolean;
  /** Whether an applied lifecycle mutation emits SSE. Defaults to true. */
  emit?: boolean;
}

export type FakeHttpStep =
  | ({ kind: "accept-then-close" } & FakeHttpCommitOptions)
  | ({ kind: "delay-forever" } & FakeHttpCommitOptions)
  | ({ kind: "status"; status: 408 | 429 | 500; body?: unknown } & FakeHttpCommitOptions)
  | ({ kind: "malformed-json"; text: string; status?: number } & FakeHttpCommitOptions)
  | ({
      kind: "truncate-body";
      body: string;
      at: number;
      status?: number;
    } & FakeHttpCommitOptions)
  | ({ kind: "connection-reset" } & FakeHttpCommitOptions)
  | ({
      kind: "headers-then-stall";
      status?: number;
      prefix?: string;
      headers?: Readonly<Record<string, string>>;
    } & FakeHttpCommitOptions)
  | ({
      kind: "success";
      status?: number;
      body?: unknown;
      headers?: Readonly<Record<string, string>>;
    } & FakeHttpCommitOptions)
  | ({
      kind: "barrier";
      barrier: FakeBarrier;
      then?: FakeHttpStep;
    } & FakeHttpCommitOptions);

export const httpFaults = {
  acceptThenClose(
    persisted?: unknown,
    options: Omit<FakeHttpCommitOptions, "persisted"> = {},
  ): FakeHttpStep {
    return {
      kind: "accept-then-close",
      ...options,
      ...(persisted === undefined ? {} : { persisted }),
    };
  },
  delayForever(options: FakeHttpCommitOptions = {}): FakeHttpStep {
    return { kind: "delay-forever", ...options };
  },
  status(status: 408 | 429 | 500, body: unknown = { error: String(status) }): FakeHttpStep {
    return { kind: "status", status, body };
  },
  malformedJson(text = `{"broken":`): FakeHttpStep {
    return { kind: "malformed-json", text };
  },
  truncateBody(body = JSON.stringify({ ok: true }), at = 1): FakeHttpStep {
    return { kind: "truncate-body", body, at };
  },
  connectionReset(): FakeHttpStep {
    return { kind: "connection-reset" };
  },
  headersThenStall(prefix = ""): FakeHttpStep {
    return { kind: "headers-then-stall", prefix };
  },
  success(body: unknown = { ok: true }, status = 200): FakeHttpStep {
    return { kind: "success", status, body };
  },
  barrier(barrier: FakeBarrier, then?: FakeHttpStep): FakeHttpStep {
    return {
      kind: "barrier",
      barrier,
      ...(then === undefined ? {} : { then }),
    };
  },
} as const;

export type FakePathMatcher = string | RegExp;

export interface FakeHttpScript {
  method: string;
  path: FakePathMatcher;
  steps: readonly FakeHttpStep[];
}

export interface FakeHttpRequest {
  sequence: number;
  method: string;
  path: string;
  url: string;
  headers: Readonly<http.IncomingHttpHeaders>;
  rawBody: string;
  body: unknown;
}

export interface FakeCommittedMutation {
  sequence: number;
  request: FakeHttpRequest;
  persisted: unknown;
}

export interface FakeSseEvent {
  id?: string;
  data: unknown;
}

export type FakeSseReplay =
  | "none"
  | "all"
  | "after-exclusive"
  | "after-inclusive";

export interface FakeSseConnectionScript {
  replay?: FakeSseReplay;
  dropEventTypes?: readonly string[];
  duplicateEventTypes?: readonly string[];
  disconnectAfterEvent?: number;
  /** Permutation of replay-event indexes. Unlisted indexes follow in order. */
  reorder?: readonly number[];
  /** Send headers but no events and ignore future emissions. */
  silent?: boolean;
}

export interface FakeSessionMessage {
  id: string;
  body: unknown;
  acceptedAt: number;
  finished: boolean;
  operationId?: string;
}

export interface FakePendingPermission {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
  revision?: string;
}

export interface FakePendingQuestion {
  id: string;
  sessionID: string;
  questions: Array<Record<string, unknown>>;
  revision?: string;
}

export interface FakeSessionState {
  id: string;
  title: string;
  status: "idle" | "busy" | "unknown";
  messages: FakeSessionMessage[];
  incomplete: boolean;
  operationId?: string;
  revision: number;
}

export interface AddPendingOptions {
  /** Defaults to true; set false to model an event missed while disconnected. */
  emit?: boolean;
  operationId?: string;
  id?: string;
}

export interface FakeOpenCodeLifecycle {
  createSession(input?: { id?: string; title?: string; operationId?: string }): FakeSessionState;
  session(id: string): FakeSessionState | undefined;
  sessions(): FakeSessionState[];
  addPermission(
    sessionId: string,
    permission: Omit<FakePendingPermission, "sessionID">,
    options?: AddPendingOptions,
  ): FakePendingPermission;
  addQuestion(
    sessionId: string,
    question: Omit<FakePendingQuestion, "sessionID">,
    options?: AddPendingOptions,
  ): FakePendingQuestion;
  pendingPermissions(): FakePendingPermission[];
  pendingQuestions(): FakePendingQuestion[];
  acceptMessage(
    sessionId: string,
    body: unknown,
    options?: AddPendingOptions,
  ): FakeSessionMessage;
  setBusy(sessionId: string, options?: AddPendingOptions): void;
  finishTurn(sessionId: string, options?: AddPendingOptions): void;
  hardDeath(sessionId: string): Promise<void>;
}

export interface FakeOpenCode {
  readonly baseUrl: string;
  readonly server: http.Server;
  readonly lifecycle: FakeOpenCodeLifecycle;
  scriptHttp(script: FakeHttpScript): void;
  clearHttpScripts(): void;
  requests(): readonly FakeHttpRequest[];
  commits(): readonly FakeCommittedMutation[];
  requestCount(method?: string, path?: FakePathMatcher): number;
  waitForRequest(input?: {
    method?: string;
    path?: FakePathMatcher;
    count?: number;
  }): Promise<FakeHttpRequest>;
  waitForCommit(count?: number): Promise<FakeCommittedMutation>;
  scriptSse(...scripts: readonly FakeSseConnectionScript[]): void;
  emitSse(event: FakeSseEvent | unknown): void;
  emitSseBatch(
    events: readonly (FakeSseEvent | unknown)[],
    order?: readonly number[],
  ): void;
  disconnectSse(): void;
  waitForSseConnections(count?: number): Promise<number>;
  waitForSseDisconnects(count?: number): Promise<number>;
  /** Recreate retained backend state on a different real-socket endpoint,
   * optionally rotating its Basic credentials at the same boundary. */
  restart(options?: FakeRestartOptions): Promise<FakeOpenCode>;
  close(): Promise<void>;
  crash(): Promise<void>;
}

interface MutableHttpScript {
  method: string;
  path: FakePathMatcher;
  steps: readonly FakeHttpStep[];
  cursor: number;
}

interface SseConnection {
  response: http.ServerResponse;
  script: FakeSseConnectionScript;
  sentEvents: number;
  closed: boolean;
}

interface Waiter<T> {
  test(): T | undefined;
  resolve(value: T): void;
  reject(error: Error): void;
}

const isMutation = (method: string): boolean =>
  method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";

const matchesPath = (matcher: FakePathMatcher, path: string): boolean => {
  if (typeof matcher === "string") return matcher === path;
  matcher.lastIndex = 0;
  return matcher.test(path);
};

const parseJson = (raw: string): unknown => {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

const readRequest = async (request: http.IncomingMessage): Promise<string> => {
  request.setEncoding("utf8");
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw;
};

const jsonResponse = (
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void => {
  if (status === 204 || body === undefined) {
    response.writeHead(status, headers);
    response.end();
    return;
  }
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain" : "application/json",
    ...headers,
  });
  response.end(raw);
};

const eventType = (event: FakeSseEvent): string | undefined => {
  if (!event.data || typeof event.data !== "object" || !("type" in event.data)) {
    return undefined;
  }
  return typeof event.data.type === "string" ? event.data.type : undefined;
};

const asSseEvent = (value: FakeSseEvent | unknown): FakeSseEvent => {
  if (
    value !== null &&
    typeof value === "object" &&
    "data" in value &&
    Object.keys(value).every((key) => key === "id" || key === "data") &&
    ("id" in value ? typeof value.id === "string" : true)
  ) {
    const event = value as FakeSseEvent;
    return { ...(event.id === undefined ? {} : { id: event.id }), data: event.data };
  }
  return { data: value };
};

const sseFrame = (event: FakeSseEvent): string =>
  `${event.id === undefined ? "" : `id: ${event.id}\n`}data: ${JSON.stringify(event.data)}\n\n`;

const reorder = <T>(values: readonly T[], order?: readonly number[]): T[] => {
  if (!order) return [...values];
  const used = new Set<number>();
  const result: T[] = [];
  for (const index of order) {
    if (!Number.isInteger(index) || index < 0 || index >= values.length || used.has(index)) {
      throw new RangeError("SSE reorder indexes must be unique valid event indexes");
    }
    used.add(index);
    result.push(values[index]!);
  }
  for (let index = 0; index < values.length; index += 1) {
    if (!used.has(index)) result.push(values[index]!);
  }
  return result;
};

export const createFakeOpenCode = async (
  options: FakeOpenCodeOptions = {},
): Promise<FakeOpenCode> => {
  const basicAuth = options.basicAuth ? { ...options.basicAuth } : undefined;
  const httpScripts: MutableHttpScript[] = [];
  const requestLog: FakeHttpRequest[] = [];
  const commitLog: FakeCommittedMutation[] = [];
  const eventHistory: FakeSseEvent[] = [];
  const sseScripts: FakeSseConnectionScript[] = [];
  const sseConnections = new Set<SseConnection>();
  const sockets = new Set<Socket>();
  const waiters = new Set<Waiter<unknown>>();
  const sessions = new Map<string, FakeSessionState>();
  const permissions = new Map<string, FakePendingPermission>();
  const questions = new Map<string, FakePendingQuestion>();
  let sessionSequence = 0;
  let messageSequence = 0;
  let requestSequence = 0;
  let commitSequence = 0;
  let connectionCount = 0;
  let disconnectionCount = 0;
  let sseScriptCursor = 0;
  let completionOrder = Date.now();
  let closed = false;

  const notifyWaiters = (): void => {
    for (const waiter of [...waiters]) {
      const value = waiter.test();
      if (value === undefined) continue;
      waiters.delete(waiter);
      waiter.resolve(value);
    }
  };

  const waitFor = <T>(test: () => T | undefined): Promise<T> => {
    const existing = test();
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<T>((resolve, reject) => {
      waiters.add({
        test,
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
  };

  const recordCommit = (
    request: FakeHttpRequest,
    persisted: unknown = request.body,
  ): FakeCommittedMutation => {
    const commit = {
      sequence: ++commitSequence,
      request,
      persisted,
    };
    commitLog.push(commit);
    notifyWaiters();
    return commit;
  };

  const closeSseConnection = (connection: SseConnection): void => {
    if (connection.closed) return;
    connection.closed = true;
    sseConnections.delete(connection);
    disconnectionCount += 1;
    notifyWaiters();
  };

  const sendToConnection = (
    connection: SseConnection,
    event: FakeSseEvent,
  ): void => {
    if (connection.closed || connection.script.silent) return;
    const type = eventType(event);
    if (type && connection.script.dropEventTypes?.includes(type)) return;

    connection.sentEvents += 1;
    connection.response.write(sseFrame(event));
    if (type && connection.script.duplicateEventTypes?.includes(type)) {
      connection.response.write(sseFrame(event));
    }
    if (
      connection.script.disconnectAfterEvent !== undefined &&
      connection.sentEvents >= connection.script.disconnectAfterEvent
    ) {
      closeSseConnection(connection);
      connection.response.end();
    }
  };

  const publish = (input: FakeSseEvent | unknown): void => {
    const event = asSseEvent(input);
    eventHistory.push(event);
    for (const connection of [...sseConnections]) sendToConnection(connection, event);
  };

  const requireSession = (id: string): FakeSessionState => {
    const session = sessions.get(id);
    if (!session) throw new Error(`fake OpenCode session ${id} does not exist`);
    return session;
  };

  const lifecycle: FakeOpenCodeLifecycle = {
    createSession(input = {}): FakeSessionState {
      const id = input.id ?? `ses_${++sessionSequence}`;
      const existing = sessions.get(id);
      if (existing) return existing;
      const session: FakeSessionState = {
        id,
        title: input.title ?? "Untitled session",
        status: "idle",
        messages: [],
        incomplete: false,
        ...(input.operationId ? { operationId: input.operationId } : {}),
        revision: 1,
      };
      sessions.set(id, session);
      return session;
    },
    session(id): FakeSessionState | undefined {
      return sessions.get(id);
    },
    sessions(): FakeSessionState[] {
      return [...sessions.values()];
    },
    addPermission(sessionId, permission, options = {}): FakePendingPermission {
      requireSession(sessionId);
      const pending = {
        ...permission,
        sessionID: sessionId,
        revision: permission.revision ?? `permission:${permission.id}:pending`,
      };
      permissions.set(pending.id, pending);
      if (options.emit !== false) {
        publish({
          id: `evt_permission_${pending.id}`,
          data: {
            type: "permission.asked",
            properties: {
              id: pending.id,
              sessionID: sessionId,
              permission: pending.permission,
              patterns: pending.patterns,
              ...(pending.metadata ? { metadata: pending.metadata } : {}),
            },
          },
        });
      }
      return pending;
    },
    addQuestion(sessionId, question, options = {}): FakePendingQuestion {
      requireSession(sessionId);
      const pending = {
        ...question,
        sessionID: sessionId,
        revision: question.revision ?? `question:${question.id}:pending`,
      };
      questions.set(pending.id, pending);
      if (options.emit !== false) {
        publish({
          id: `evt_question_${pending.id}`,
          data: {
            type: "question.asked",
            properties: {
              id: pending.id,
              sessionID: sessionId,
              questions: pending.questions,
            },
          },
        });
      }
      return pending;
    },
    pendingPermissions(): FakePendingPermission[] {
      return [...permissions.values()];
    },
    pendingQuestions(): FakePendingQuestion[] {
      return [...questions.values()];
    },
    acceptMessage(sessionId, body, options = {}): FakeSessionMessage {
      const session = requireSession(sessionId);
      const message = {
        id: options.id ?? `msg_${++messageSequence}`,
        body,
        acceptedAt: Date.now(),
        finished: false,
        ...(options.operationId ? { operationId: options.operationId } : {}),
      };
      session.messages.push(message);
      session.status = "busy";
      session.revision += 1;
      if (options.emit !== false) {
        publish({
          id: `evt_message_${message.id}`,
          data: {
            type: "message.updated",
            properties: {
              sessionID: sessionId,
              info: { id: message.id, role: "user", sessionID: sessionId },
            },
          },
        });
        publish({
          id: `evt_busy_${message.id}`,
          data: {
            type: "session.status",
            properties: { sessionID: sessionId, status: { type: "busy" } },
          },
        });
      }
      return message;
    },
    setBusy(sessionId, options = {}): void {
      const session = requireSession(sessionId);
      session.status = "busy";
      session.revision += 1;
      if (options.emit !== false) {
        publish({
          data: {
            type: "session.status",
            properties: { sessionID: sessionId, status: { type: "busy" } },
          },
        });
      }
    },
    finishTurn(sessionId, options = {}): void {
      const session = requireSession(sessionId);
      session.status = "idle";
      session.revision += 1;
      const current = session.messages.at(-1);
      if (current) current.finished = true;
      if (options.emit !== false) {
        completionOrder = Math.max(completionOrder + 1, Date.now());
        const assistantMessageId = `msg_assistant_${++messageSequence}`;
        publish({
          id: `evt_message_${assistantMessageId}`,
          data: {
            type: "message.updated",
            properties: {
              sessionID: sessionId,
              info: {
                id: assistantMessageId,
                role: "assistant",
                sessionID: sessionId,
                time: {
                  created: completionOrder - 1,
                  completed: completionOrder,
                },
              },
            },
          },
        });
        publish({
          data: {
            type: "session.idle",
            properties: { sessionID: sessionId },
          },
        });
      }
    },
    async hardDeath(sessionId): Promise<void> {
      const session = requireSession(sessionId);
      session.status = "unknown";
      session.incomplete = true;
      await crash();
    },
  };

  const operationIdOf = (request: FakeHttpRequest): string | undefined => {
    const value = request.headers["x-polyth-operation-id"];
    return Array.isArray(value) ? value[0] : value;
  };

  /** Apply the same authoritative state transition as the unscripted route,
   * but leave response behavior to the selected fault step. */
  const applyLifecycleFaultEffect = (
    request: FakeHttpRequest,
    emit: boolean,
  ): unknown => {
    const operationId = operationIdOf(request);
    if (request.method === "POST" && request.path === "/session") {
      const input = request.body && typeof request.body === "object"
        ? request.body as Record<string, unknown>
        : {};
      return lifecycle.createSession({
        ...(typeof input.id === "string" ? { id: input.id } : {}),
        ...(typeof input.title === "string" ? { title: input.title } : {}),
        ...(operationId ? { operationId } : {}),
      });
    }
    const messageMatch = /^\/session\/([^/]+)\/(message|prompt_async)$/.exec(request.path);
    if (request.method === "POST" && messageMatch) {
      return lifecycle.acceptMessage(messageMatch[1]!, request.body, {
        emit,
        ...(operationId ? { operationId } : {}),
      });
    }
    const abortMatch = /^\/session\/([^/]+)\/abort$/.exec(request.path);
    if (request.method === "POST" && abortMatch) {
      lifecycle.finishTurn(abortMatch[1]!, { emit });
      return { aborted: true };
    }
    const permissionMatch = /^\/session\/([^/]+)\/permissions\/([^/]+)$/.exec(request.path);
    if (request.method === "POST" && permissionMatch) {
      permissions.delete(permissionMatch[2]!);
      return { replied: true, operationId };
    }
    const questionMatch = /^\/question\/([^/]+)\/(reply|reject)$/.exec(request.path);
    if (request.method === "POST" && questionMatch) {
      questions.delete(questionMatch[1]!);
      return { replied: true, operationId };
    }
    const deleteMatch = /^\/session\/([^/]+)$/.exec(request.path);
    if (request.method === "DELETE" && deleteMatch) {
      sessions.delete(deleteMatch[1]!);
      return { deleted: true };
    }
    return request.body;
  };

  const executeStep = async (
    step: FakeHttpStep,
    request: FakeHttpRequest,
    incoming: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> => {
    if (step.kind === "barrier") {
      if (step.commit) recordCommit(request, step.persisted);
      await step.barrier.wait();
      if (response.destroyed) return;
      const next = step.then ?? httpFaults.success();
      await executeStep(
        step.commit ? { ...next, commit: false } : next,
        request,
        incoming,
        response,
      );
      return;
    }

    const status =
      step.kind === "success" ||
      step.kind === "malformed-json" ||
      step.kind === "truncate-body" ||
      step.kind === "headers-then-stall"
        ? (step.status ?? 200)
        : step.kind === "status"
          ? step.status
          : undefined;
    const acceptedByDefault =
      isMutation(request.method) &&
      status !== undefined &&
      status >= 200 &&
      status < 300 &&
      step.kind !== "status";
    const lifecyclePersisted = step.applyLifecycle
      ? applyLifecycleFaultEffect(request, step.emit !== false)
      : undefined;
    if (
      step.kind !== "accept-then-close" &&
      (step.commit === true || (step.commit !== false && acceptedByDefault))
    ) {
      recordCommit(
        request,
        step.persisted === undefined ? lifecyclePersisted : step.persisted,
      );
    }

    if (step.kind === "accept-then-close") {
      if (step.commit !== false) {
        recordCommit(
          request,
          step.persisted === undefined ? lifecyclePersisted : step.persisted,
        );
      }
      incoming.socket.destroy();
      return;
    }
    if (step.kind === "delay-forever") return;
    if (step.kind === "connection-reset") {
      incoming.socket.destroy();
      return;
    }
    if (step.kind === "status") {
      jsonResponse(response, step.status, step.body);
      return;
    }
    if (step.kind === "malformed-json") {
      response.writeHead(step.status ?? 200, { "content-type": "application/json" });
      response.end(step.text);
      return;
    }
    if (step.kind === "truncate-body") {
      const prefix = step.body.slice(0, Math.max(0, Math.min(step.body.length, step.at)));
      response.writeHead(step.status ?? 200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(step.body),
      });
      response.write(prefix);
      response.flushHeaders();
      response.socket?.destroy();
      return;
    }
    if (step.kind === "headers-then-stall") {
      response.writeHead(step.status ?? 200, {
        "content-type": "application/json",
        ...step.headers,
      });
      response.flushHeaders();
      if (step.prefix) response.write(step.prefix);
      return;
    }
    jsonResponse(response, step.status ?? 200, step.body, step.headers);
  };

  const handleSse = (
    incoming: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
  ): void => {
    const index = sseScriptCursor;
    sseScriptCursor += 1;
    connectionCount += 1;
    const script =
      sseScripts[Math.min(index, Math.max(0, sseScripts.length - 1))] ?? {};
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.flushHeaders();
    const connection: SseConnection = {
      response,
      script,
      sentEvents: 0,
      closed: false,
    };
    sseConnections.add(connection);
    response.on("close", () => closeSseConnection(connection));
    incoming.on("aborted", () => closeSseConnection(connection));
    notifyWaiters();

    if (script.silent) return;
    const after = url.searchParams.get("after");
    let replayEvents: FakeSseEvent[] = [];
    if (script.replay === "all") replayEvents = [...eventHistory];
    if (
      (script.replay === "after-exclusive" || script.replay === "after-inclusive") &&
      after !== null
    ) {
      const cursor = eventHistory.findIndex((event) => event.id === after);
      if (cursor >= 0) {
        const offset = script.replay === "after-inclusive" ? cursor : cursor + 1;
        replayEvents = eventHistory.slice(offset);
      }
    }
    for (const event of reorder(replayEvents, script.reorder)) {
      if (connection.closed) break;
      sendToConnection(connection, event);
    }
  };

  const handleLifecycleRoute = (
    request: FakeHttpRequest,
    response: http.ServerResponse,
  ): boolean => {
    const { method, path, body } = request;

    if (method === "GET" && path === "/global/health") {
      jsonResponse(response, 200, { healthy: true, version: "fake-legacy-1" });
      return true;
    }
    if (method === "GET" && path === "/doc") {
      jsonResponse(response, 200, {
        openapi: "3.1.0",
        paths: {
          "/session/{sessionID}/prompt_async": { post: {} },
          "/session/{sessionID}/message": { post: {} },
        },
      });
      return true;
    }
    if (method === "GET" && path === "/provider") {
      jsonResponse(response, 200, {
        all: [{
          id: "fake",
          name: "Fake",
          models: { reliable: { id: "reliable", name: "Reliable" } },
        }],
        connected: ["fake"],
      });
      return true;
    }
    if (method === "GET" && path === "/agent") {
      jsonResponse(response, 200, []);
      return true;
    }

    if (method === "GET" && path === "/session") {
      jsonResponse(
        response,
        200,
        lifecycle.sessions().map((session) => ({
          id: session.id,
          title: session.title,
          time: { created: 1, updated: 1 },
          ...(session.operationId ? { operationID: session.operationId } : {}),
        })),
      );
      return true;
    }
    if (method === "POST" && path === "/session") {
      const input = body && typeof body === "object" ? body : {};
      const id = "id" in input && typeof input.id === "string" ? input.id : undefined;
      const title =
        "title" in input && typeof input.title === "string" ? input.title : undefined;
      const operationId = operationIdOf(request);
      const session = lifecycle.createSession({
        ...(id ? { id } : {}),
        ...(title ? { title } : {}),
        ...(operationId ? { operationId } : {}),
      });
      recordCommit(request, session);
      jsonResponse(response, 200, session);
      return true;
    }
    if (method === "GET" && path === "/permission") {
      jsonResponse(response, 200, lifecycle.pendingPermissions());
      return true;
    }
    if (method === "GET" && path === "/question") {
      jsonResponse(response, 200, lifecycle.pendingQuestions());
      return true;
    }
    if (method === "GET" && path === "/session/status") {
      jsonResponse(
        response,
        200,
        Object.fromEntries(lifecycle.sessions().map((session) => [
          session.id,
          { type: session.status, revision: session.revision },
        ])),
      );
      return true;
    }

    const statusMatch = /^\/session\/([^/]+)\/status$/.exec(path);
    if (method === "GET" && statusMatch) {
      const session = sessions.get(statusMatch[1]!);
      if (!session) jsonResponse(response, 404, { error: "not found" });
      else jsonResponse(response, 200, { type: session.status });
      return true;
    }

    const historyMatch = /^\/session\/([^/]+)\/message$/.exec(path);
    if (method === "GET" && historyMatch) {
      const session = sessions.get(historyMatch[1]!);
      if (!session) jsonResponse(response, 404, { error: "not found" });
      else {
        jsonResponse(
          response,
          200,
          session.messages.map((message) => ({
            info: { id: message.id, role: "user", sessionID: session.id },
            ...(message.operationId
              ? { info: {
                  id: message.id,
                  role: "user",
                  sessionID: session.id,
                  operationID: message.operationId,
                } }
              : {}),
            parts: [{
              id: `part_${message.id}`,
              messageID: message.id,
              type: "text",
              text: JSON.stringify(message.body),
              time: message.finished ? { end: message.acceptedAt + 1 } : {},
            }],
          })),
        );
      }
      return true;
    }

    const messageMatch = /^\/session\/([^/]+)\/(message|prompt_async)$/.exec(path);
    if (method === "POST" && messageMatch) {
      const session = sessions.get(messageMatch[1]!);
      if (!session) jsonResponse(response, 404, { error: "not found" });
      else {
        const operationId = operationIdOf(request);
        const message = lifecycle.acceptMessage(session.id, body, {
          ...(operationId ? { operationId } : {}),
        });
        recordCommit(request, message);
        jsonResponse(response, 200, { id: message.id });
      }
      return true;
    }

    const abortMatch = /^\/session\/([^/]+)\/abort$/.exec(path);
    if (method === "POST" && abortMatch) {
      const session = sessions.get(abortMatch[1]!);
      if (!session) jsonResponse(response, 404, { error: "not found" });
      else {
        lifecycle.finishTurn(session.id);
        recordCommit(request, { aborted: true });
        jsonResponse(response, 200, true);
      }
      return true;
    }

    const permissionMatch = /^\/session\/([^/]+)\/permissions\/([^/]+)$/.exec(path);
    if (method === "POST" && permissionMatch) {
      permissions.delete(permissionMatch[2]!);
      recordCommit(request);
      jsonResponse(response, 200, true);
      return true;
    }

    const questionMatch = /^\/question\/([^/]+)\/(reply|reject)$/.exec(path);
    if (method === "POST" && questionMatch) {
      questions.delete(questionMatch[1]!);
      recordCommit(request);
      jsonResponse(response, 200, true);
      return true;
    }

    const deleteMatch = /^\/session\/([^/]+)$/.exec(path);
    if (method === "DELETE" && deleteMatch) {
      sessions.delete(deleteMatch[1]!);
      recordCommit(request);
      response.writeHead(204);
      response.end();
      return true;
    }
    return false;
  };

  const server = http.createServer((incoming, response) => {
    void (async () => {
      const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
      const authorized = !basicAuth
        || incoming.headers.authorization === `Basic ${Buffer.from(
          `${basicAuth.username}:${basicAuth.password}`,
        ).toString("base64")}`;
      if (incoming.method === "GET" && url.pathname === "/event") {
        if (!authorized) {
          jsonResponse(response, 401, { error: "unauthorized" }, {
            "www-authenticate": 'Basic realm="fake-opencode"',
          });
          return;
        }
        handleSse(incoming, response, url);
        return;
      }

      const rawBody = await readRequest(incoming);
      const request: FakeHttpRequest = {
        sequence: ++requestSequence,
        method: (incoming.method ?? "GET").toUpperCase(),
        path: url.pathname,
        url: `${url.pathname}${url.search}`,
        headers: Object.freeze({ ...incoming.headers }),
        rawBody,
        body: parseJson(rawBody),
      };
      requestLog.push(request);
      notifyWaiters();

      if (!authorized) {
        jsonResponse(response, 401, { error: "unauthorized" }, {
          "www-authenticate": 'Basic realm="fake-opencode"',
        });
        return;
      }

      const script = httpScripts.find(
        (candidate) =>
          candidate.method === request.method && matchesPath(candidate.path, request.path),
      );
      if (script) {
        const step = script.steps[Math.min(script.cursor, script.steps.length - 1)]!;
        script.cursor += 1;
        await executeStep(step, request, incoming, response);
        return;
      }
      if (handleLifecycleRoute(request, response)) return;
      jsonResponse(response, 404, { error: "not found" });
    })().catch((error: unknown) => {
      if (response.destroyed) return;
      jsonResponse(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const stop = async (abrupt: boolean): Promise<void> => {
    if (closed) return;
    closed = true;
    if (abrupt) {
      for (const socket of sockets) socket.destroy();
    } else {
      for (const connection of sseConnections) connection.response.end();
      server.closeAllConnections();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const error = new Error("fake OpenCode server closed");
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  };

  async function crash(): Promise<void> {
    await stop(true);
  }

  return {
    baseUrl,
    server,
    lifecycle,
    scriptHttp(script): void {
      if (script.steps.length === 0) {
        throw new RangeError("HTTP fault script requires at least one step");
      }
      httpScripts.push({
        method: script.method.toUpperCase(),
        path: script.path,
        steps: [...script.steps],
        cursor: 0,
      });
    },
    clearHttpScripts(): void {
      httpScripts.length = 0;
    },
    requests(): readonly FakeHttpRequest[] {
      return requestLog;
    },
    commits(): readonly FakeCommittedMutation[] {
      return commitLog;
    },
    requestCount(method, path): number {
      return requestLog.filter(
        (request) =>
          (method === undefined || request.method === method.toUpperCase()) &&
          (path === undefined || matchesPath(path, request.path)),
      ).length;
    },
    waitForRequest(input = {}): Promise<FakeHttpRequest> {
      const wanted = input.count ?? 1;
      return waitFor(() => {
        const matching = requestLog.filter(
          (request) =>
            (input.method === undefined ||
              request.method === input.method.toUpperCase()) &&
            (input.path === undefined || matchesPath(input.path, request.path)),
        );
        return matching.length >= wanted ? matching[wanted - 1] : undefined;
      });
    },
    waitForCommit(count = 1): Promise<FakeCommittedMutation> {
      return waitFor(() => commitLog[count - 1]);
    },
    scriptSse(...scripts): void {
      sseScripts.length = 0;
      sseScripts.push(...scripts);
      sseScriptCursor = 0;
    },
    emitSse(event): void {
      publish(event);
    },
    emitSseBatch(events, order): void {
      for (const event of reorder(events, order)) publish(event);
    },
    disconnectSse(): void {
      for (const connection of [...sseConnections]) {
        closeSseConnection(connection);
        connection.response.end();
      }
    },
    waitForSseConnections(count = 1): Promise<number> {
      return waitFor(() => (connectionCount >= count ? connectionCount : undefined));
    },
    waitForSseDisconnects(count = 1): Promise<number> {
      return waitFor(() =>
        disconnectionCount >= count ? disconnectionCount : undefined,
      );
    },
    async restart(restartOptions = {}): Promise<FakeOpenCode> {
      const nextBasicAuth = restartOptions.basicAuth === undefined
        ? basicAuth
        : restartOptions.basicAuth ?? undefined;
      const next = await createFakeOpenCode(
        nextBasicAuth ? { basicAuth: nextBasicAuth } : {},
      );
      for (const source of sessions.values()) {
        const restored = next.lifecycle.createSession({
          id: source.id,
          title: source.title,
          ...(source.operationId ? { operationId: source.operationId } : {}),
        });
        for (const message of source.messages) {
          next.lifecycle.acceptMessage(source.id, structuredClone(message.body), {
            emit: false,
            id: message.id,
            ...(message.operationId ? { operationId: message.operationId } : {}),
          });
          const copied = restored.messages.at(-1);
          if (copied) {
            copied.acceptedAt = message.acceptedAt;
            copied.finished = message.finished;
          }
        }
        restored.status = source.status;
        restored.incomplete = source.incomplete;
        restored.revision = source.revision;
      }
      for (const permission of permissions.values()) {
        const { sessionID, ...copy } = permission;
        next.lifecycle.addPermission(sessionID, structuredClone(copy), { emit: false });
      }
      for (const question of questions.values()) {
        const { sessionID, ...copy } = question;
        next.lifecycle.addQuestion(sessionID, structuredClone(copy), { emit: false });
      }
      return next;
    },
    close(): Promise<void> {
      return stop(false);
    },
    crash,
  };
};
