import type { CommandCodeRpc } from "./rpc.ts";

/**
 * Keep product title authority out of the execution receipt journal.
 * SessionService supplies the current canonical title on every attach. The
 * wrapper injects only that value into the next native start/resume request;
 * no binding JSON is rewritten and no Command Code transcript/config is read.
 */
export function createCommandCodeTitleSync(rpc: CommandCodeRpc): {
  rpc: CommandCodeRpc;
  capture(title: string | undefined): void;
  current(): string;
} {
  let canonicalTitle = "";
  const wrapped: CommandCodeRpc = {
    authorityId: rpc.authorityId,
    generation: rpc.generation,
    get receipts() { return rpc.receipts; },
    get releasedAuthorities() { return rpc.releasedAuthorities; },
    request<T>(command, timeoutMs) {
      const request = command.type === "start_turn" && canonicalTitle
        ? { ...command, title: canonicalTitle }
        : command;
      return rpc.request<T>(request, timeoutMs);
    },
    receipt: (operationId, nativeId) => rpc.receipt(operationId, nativeId),
    onEvent: (callback) => rpc.onEvent(callback),
    onClose: (callback) => rpc.onClose(callback),
    close: () => rpc.close(),
  };
  return {
    rpc: wrapped,
    capture(title) {
      const next = title?.trim();
      if (next) canonicalTitle = next;
    },
    current: () => canonicalTitle,
  };
}
