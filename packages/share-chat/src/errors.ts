/** Stable error codes; `http-<status>` carries the upstream status. */
export type ShareChatErrorCode =
  | "aborted"
  | "blocked"
  | "invalid-input"
  | "network"
  | "not-a-share-url"
  | "share-unavailable"
  | "timeout"
  | "too-large"
  | "unavailable"
  | "unreadable-page"
  | "unsupported-host"
  | "unsupported-page"
  | `http-${number}`;

export function shareChatError(code: ShareChatErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function shareChatErrorCode(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
