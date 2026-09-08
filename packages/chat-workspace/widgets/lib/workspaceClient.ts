import type { ChatTabDto, ChatWorkspaceDto } from "@polyth/contracts";
import type { ApiTransport } from "@polyth/web-sdk";

export type WorkspaceState = {
  tabs: ChatTabDto[];
  order: string[];
  activeTabId: string | null;
};

export function workspaceFromDto(dto: ChatWorkspaceDto): WorkspaceState {
  return {
    tabs: dto.tabs,
    order: dto.order.length ? dto.order : dto.tabs.map((t) => t.id),
    activeTabId: dto.activeTabId,
  };
}

export async function postTabAction(
  transport: ApiTransport,
  projectId: string,
  tabId: string,
  action: string,
  body?: Record<string, unknown>,
): Promise<ChatWorkspaceDto | null> {
  const res = await transport.post<ChatWorkspaceDto | { ok: boolean }>(
    `/api/chat-workspace/tabs/${encodeURIComponent(tabId)}/${action}?projectId=${encodeURIComponent(projectId)}`,
    body ?? {},
  );
  if (res && "tabs" in res) return res;
  return null;
}

export async function closeTab(
  transport: ApiTransport,
  projectId: string,
  tabId: string,
): Promise<ChatWorkspaceDto> {
  return transport.delete<ChatWorkspaceDto>(
    `/api/chat-workspace/tabs/${encodeURIComponent(tabId)}?projectId=${encodeURIComponent(projectId)}`,
  );
}
