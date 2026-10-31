import type { RpcPeer } from "../src/rpc.ts";
export function fakeRpc() {
    const calls: Array<{
        method: string;
        params: any;
    }> = [];
    const receipts: Record<string, string> = {};
    let notification = (_method: string, _params: any) => { };
    let inbound = async (_method: string, _params: any): Promise<unknown> => ({});
    let closed = () => { };
    let handler = async (_method: string, _params: any): Promise<any> => ({});
    const rpc: RpcPeer = {
        authorityId: "authority", generation: 1, receipts, releasedAuthorities: [],
        request: async (method, params) => { calls.push({ method, params }); return handler(method, params); },
        notify: (method, params) => { calls.push({ method, params }); },
        receipt: async (op, id) => { receipts[op] = id; },
        onNotification: cb => { notification = cb; }, onRequest: cb => { inbound = cb; }, onClose: cb => { closed = cb; },
        close: async () => { closed(); },
    };
    return { rpc, calls, handle(fn: typeof handler) { handler = fn; }, emit(method: string, params: any) { notification(method, params); }, request(method: string, params: any) { return inbound(method, params); }, disconnect() { closed(); } };
}
