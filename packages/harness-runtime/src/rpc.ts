import { createHarnessProcessAuthority } from "./processAuthority.ts";

const RPC_TEXT_LIMIT = 500;
const SENSITIVE_RPC_KEY = /(?:authorization|cookie|credential|password|passphrase|private.?key|secret|token|api.?key)/i;

const sanitizedRpcText = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const text = value
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .replace(/((?:authorization|cookie|credential|password|secret|token|api[-_ ]?key)\s*[=:]\s*)\S+/gi, "$1[redacted]")
        .trim();
    if (!text) return undefined;
    return text.length > RPC_TEXT_LIMIT ? `${text.slice(0, RPC_TEXT_LIMIT)}…` : text;
};

const sanitizeRpcDataValue = (value: unknown, depth = 0): unknown => {
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") return sanitizedRpcText(value);
    if (depth >= 3) return "[truncated]";
    if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitizeRpcDataValue(entry, depth + 1));
    if (!value || typeof value !== "object") return undefined;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, 20)) {
        result[key] = SENSITIVE_RPC_KEY.test(key) ? "[redacted]" : sanitizeRpcDataValue(entry, depth + 1);
    }
    return result;
};

const sanitizedRpcData = (value: unknown): unknown => {
    if (value === undefined) return undefined;
    const safe = sanitizeRpcDataValue(value);
    try {
        return JSON.stringify(safe).length <= 2_048 ? safe : "[truncated]";
    }
    catch {
        return undefined;
    }
};
export interface RpcPeer {
    request<T = Record<string, unknown>>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
    notify(method: string, params: unknown): void;
    onNotification(callback: (method: string, params: any) => void): void;
    onRequest(callback: (method: string, params: any) => Promise<unknown>): void;
    onClose(callback: () => void): void;
    close(): Promise<void>;
    readonly authorityId: string;
    readonly generation: number;
    readonly releasedAuthorities: readonly {
        authorityId: string;
        generation: number;
    }[];
    readonly receipts: Readonly<Record<string, string>>;
    receipt(operationId: string, nativeId: string): Promise<void>;
}
/** Bounded bidirectional JSON-RPC over stdio. No retries. Vendor schemas stay
 * in adapters. A missing response is ambiguous, including on timeout/EOF. */
export async function createStdioRpc(options: {
    command: string;
    args: string[];
    cwd: string;
    stateFile?: string;
    stableAuthority?: boolean;
    env?: NodeJS.ProcessEnv;
}): Promise<RpcPeer> {
    const authority = await createHarnessProcessAuthority(options.stateFile, options.stableAuthority);
    const child = authority.spawn(options.command, options.args, { cwd: options.cwd, env: options.env ?? process.env });
    let closed = false;
    let nextId = 0;
    let bytes = Buffer.alloc(0);
    const pending = new Map<number, {
        method: string;
        resolve(value: any): void;
        reject(error: Error): void;
        timer?: NodeJS.Timeout;
    }>();
    const notifications: Array<(method: string, params: any) => void> = [];
    const closes: Array<() => void> = [];
    let requests: (method: string, params: any) => Promise<unknown> = async () => { throw new Error("unsupported request"); };
    const disconnected = () => {
        if (closed)
            return;
        closed = true;
        for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(Object.assign(new Error(`Runtime response was lost for "${entry.method}"`), {
                code: "outcome-unknown",
                rpcMethod: entry.method,
            }));
        }
        pending.clear();
        closes.forEach((cb) => cb());
    };
    child.on("error", disconnected);
    child.on("close", disconnected);
    child.stdin!.on("error", disconnected);
    child.stdout!.on("error", disconnected);
    child.stderr!.on("error", disconnected);
    // Always consume stderr; credentials/diagnostics from native CLIs are never
    // reflected verbatim in an API response or continuity context.
    child.stderr!.resume();
    const send = (value: unknown) => { if (closed)
        throw Object.assign(new Error("Runtime connection is closed"), { code: "outcome-unknown" }); child.stdin!.write(JSON.stringify(value) + "\n"); };
    child.stdout!.on("data", (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk]);
        while (true) {
            const end = bytes.indexOf(10);
            if (end < 0)
                break;
            const line = bytes.subarray(0, end);
            bytes = bytes.subarray(end + 1);
            if (line.length > 8 * 1024 * 1024) {
                disconnected();
                void authority.close().catch(() => { });
                return;
            }
            if (!line.length)
                continue;
            let message: any;
            try {
                message = JSON.parse(line.toString("utf8"));
            }
            catch {
                disconnected();
                void authority.close().catch(() => { });
                return;
            }
            if (!message || typeof message !== "object" || Array.isArray(message)) {
                disconnected();
                void authority.close().catch(() => { });
                return;
            }
            if (typeof message.method === "string") {
                if (message.id !== undefined)
                    void requests(message.method, message.params ?? {}).then((result) => send({ jsonrpc: "2.0", id: message.id, result }), () => send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported client request" } })).catch(() => { });
                else
                    try {
                        notifications.forEach((cb) => cb(message.method, message.params ?? {}));
                    }
                    catch {
                        disconnected();
                        void authority.close().catch(() => { });
                        return;
                    }
            }
            else {
                const entry = pending.get(message.id);
                if (!entry)
                    continue;
                pending.delete(message.id);
                clearTimeout(entry.timer);
                if (message.error) {
                    const remoteMessage = sanitizedRpcText(message.error.message);
                    const rpcData = sanitizedRpcData(message.error.data);
                    entry.reject(Object.assign(
                        new Error(`runtime rejected "${entry.method}"${remoteMessage ? `: ${remoteMessage}` : ""}`),
                        {
                            code: "runtime-rejected",
                            rpcMethod: entry.method,
                            ...(typeof message.error.code === "number" ? { rpcCode: message.error.code } : {}),
                            ...(remoteMessage ? { remoteMessage } : {}),
                            ...(rpcData === undefined ? {} : { rpcData }),
                        },
                    ));
                }
                else entry.resolve(message.result);
            }
        }
        if (bytes.length > 8 * 1024 * 1024) {
            disconnected();
            void authority.close().catch(() => { });
        }
    });
    try {
        await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    }
    catch (error) {
        await authority.close().catch(() => { });
        disconnected();
        throw error;
    }
    return {
        authorityId: authority.authorityId,
        generation: authority.generation,
        releasedAuthorities: authority.releasedAuthorities,
        get receipts() { return authority.receipts; },
        receipt: authority.receipt,
        request<T>(method: string, params: unknown, timeoutMs = 20000): Promise<T> {
            const id = ++nextId;
            return new Promise<T>((resolve, reject) => {
                const timer = timeoutMs > 0 ? setTimeout(() => { pending.delete(id); reject(Object.assign(new Error("Runtime response timed out"), { code: "outcome-unknown" })); }, timeoutMs) : undefined;
                timer?.unref();
                pending.set(id, { method, resolve, reject, timer });
                try {
                    send({ jsonrpc: "2.0", id, method, params });
                }
                catch (error) {
                    pending.delete(id);
                    clearTimeout(timer);
                    reject(error);
                }
            });
        },
        notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
        onNotification: (cb) => { notifications.push(cb); }, onRequest: (cb) => { requests = cb; }, onClose: (cb) => { closes.push(cb); },
        async close() {
            try { await authority.close(); }
            finally { disconnected(); }
        },
    };
}
