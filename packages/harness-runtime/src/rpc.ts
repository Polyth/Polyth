import { createProcessAuthority } from "./authority.ts";
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
    const authority = await createProcessAuthority(options.stateFile, options.stableAuthority);
    const child = authority.spawn(options.command, options.args, { cwd: options.cwd, env: options.env ?? process.env });
    // Always consume stderr; credentials/diagnostics from native CLIs are never
    // reflected verbatim in an API response or continuity context.
    child.stderr!.resume();
    let closed = false;
    let nextId = 0;
    let bytes = Buffer.alloc(0);
    const pending = new Map<number, {
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
            entry.reject(Object.assign(new Error("Runtime response was lost"), { code: "outcome-unknown" }));
        }
        pending.clear();
        closes.forEach((cb) => cb());
    };
    child.on("error", disconnected);
    child.on("close", disconnected);
    child.stdin!.on("error", disconnected);
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
                message.error ? entry.reject(Object.assign(new Error("Runtime rejected the request"), { code: "runtime-rejected", rpcCode: message.error.code })) : entry.resolve(message.result);
            }
        }
        if (bytes.length > 8 * 1024 * 1024) {
            disconnected();
            void authority.close().catch(() => { });
        }
    });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    return {
        authorityId: authority.authorityId, generation: authority.generation, releasedAuthorities: authority.releasedAuthorities,
        get receipts() { return authority.receipts; },
        receipt: authority.receipt,
        request<T>(method: string, params: unknown, timeoutMs = 20000): Promise<T> {
            const id = ++nextId;
            return new Promise<T>((resolve, reject) => {
                const timer = timeoutMs > 0 ? setTimeout(() => { pending.delete(id); reject(Object.assign(new Error("Runtime response timed out"), { code: "outcome-unknown" })); }, timeoutMs) : undefined;
                timer?.unref();
                pending.set(id, { resolve, reject, timer });
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
        async close() { await authority.close(); disconnected(); },
    };
}
