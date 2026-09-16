export interface IdempotentMutationError extends Error {
  status?: number;
  code?: string;
  details?: string;
  field?: string;
  operationId: string;
  uncertain: boolean;
}

export interface IdempotentMutationClient {
  request<T>(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T>;
}

export interface IdempotentMutationClientOptions {
  fetch?: typeof fetch;
  operationId?: () => string;
  onUnauthorized?: () => void;
}

/**
 * Browser-side half of the durable idempotency contract.
 *
 * One logical intent keeps one 128-bit operation id until the server gives a
 * confirmed result. Network failures, 5xx responses and malformed 2xx bodies
 * remain uncertain and therefore retain the key for the next identical retry.
 * A confirmed success or 4xx releases it so a later deliberate repeat is a new
 * operation. Concurrent identical calls naturally share the same key.
 */
export function createIdempotentMutationClient(
  options: IdempotentMutationClientOptions = {},
): IdempotentMutationClient {
  const pending = new Map<string, string>();
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const newOperationId = options.operationId ?? (() => globalThis.crypto.randomUUID());

  const operationIdFor = (intent: string): string => {
    const existing = pending.get(intent);
    if (existing) return existing;
    const id = newOperationId();
    pending.set(intent, id);
    return id;
  };

  return {
    async request<T>(path, method, body): Promise<T> {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const intent = `${method}\n${path}\n${encoded ?? ""}`;
      const operationId = operationIdFor(intent);
      let response: Response;
      try {
        response = await fetcher(path, {
          method,
          headers: {
            "Idempotency-Key": operationId,
            ...(encoded === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(encoded === undefined ? {} : { body: encoded }),
        });
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error("network request failed");
        throw Object.assign(error, { operationId, uncertain: true }) as IdempotentMutationError;
      }

      const raw = await response.text().catch(() => "");
      if (!response.ok) {
        const uncertain = response.status >= 500;
        if (!uncertain) pending.delete(intent);
        if (response.status === 401) options.onUnauthorized?.();
        let code: string | undefined;
        let message: string | undefined;
        let details: string | undefined;
        let field: string | undefined;
        try {
          const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown; details?: unknown; field?: unknown };
          if (typeof parsed.error === "string") code = parsed.error;
          if (typeof parsed.message === "string") message = parsed.message;
          if (typeof parsed.details === "string") details = parsed.details;
          if (typeof parsed.field === "string") field = parsed.field;
        } catch { /* non-JSON error body */ }
        throw Object.assign(new Error(message ?? `HTTP ${response.status} ${response.statusText}`.trim()), {
          status: response.status,
          operationId,
          uncertain,
          ...(code !== undefined ? { code } : {}),
          ...(details !== undefined ? { details } : {}),
          ...(field !== undefined ? { field } : {}),
        }) as IdempotentMutationError;
      }

      if (response.status === 204) {
        pending.delete(intent);
        return undefined as T;
      }
      try {
        const value = JSON.parse(raw) as T;
        pending.delete(intent);
        return value;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error("invalid response body");
        throw Object.assign(error, { operationId, uncertain: true }) as IdempotentMutationError;
      }
    },
  };
}
