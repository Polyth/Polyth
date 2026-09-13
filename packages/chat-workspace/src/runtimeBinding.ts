import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpaceStorage } from "@polyth/contracts";
import {
  DEFAULT_CHAT_WORKSPACE_RUNTIME_PREFERENCE,
  type ChatWorkspaceRuntimePreference,
} from "./runtime.ts";

export interface ChatWorkspaceProjectRuntimeBinding {
  preference: ChatWorkspaceRuntimePreference;
  updatedAt: number;
}

const bindingPath = (storage: SpaceStorage, projectId: string): string =>
  storage.path(join("packages", "chat-workspace", "projects", projectId, "runtime.json"));

export async function loadProjectRuntimeBinding(
  storage: SpaceStorage,
  projectId: string,
): Promise<ChatWorkspaceProjectRuntimeBinding> {
  try {
    const raw = JSON.parse(await readFile(bindingPath(storage, projectId), "utf8")) as Partial<ChatWorkspaceProjectRuntimeBinding>;
    const preference = raw.preference && typeof raw.preference === "object"
      ? normalizeRuntimePreference(raw.preference)
      : { ...DEFAULT_CHAT_WORKSPACE_RUNTIME_PREFERENCE };
    return {
      preference,
      updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    };
  } catch {
    return {
      preference: { ...DEFAULT_CHAT_WORKSPACE_RUNTIME_PREFERENCE },
      updatedAt: 0,
    };
  }
}

export async function saveProjectRuntimeBinding(
  storage: SpaceStorage,
  projectId: string,
  preference: ChatWorkspaceRuntimePreference,
): Promise<ChatWorkspaceProjectRuntimeBinding> {
  const normalized = normalizeRuntimePreference(preference);
  const path = bindingPath(storage, projectId);
  await mkdir(storage.path(join("packages", "chat-workspace", "projects", projectId)), { recursive: true });
  const binding: ChatWorkspaceProjectRuntimeBinding = {
    preference: normalized,
    updatedAt: Date.now(),
  };
  await writeFile(path, `${JSON.stringify(binding, null, 2)}\n`);
  return binding;
}

export function normalizeRuntimePreference(value: unknown): ChatWorkspaceRuntimePreference {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const mode = raw.mode === "local-only" || raw.mode === "remote" || raw.mode === "local-first"
    ? raw.mode
    : DEFAULT_CHAT_WORKSPACE_RUNTIME_PREFERENCE.mode;
  const deviceId = typeof raw.deviceId === "string" && raw.deviceId.trim()
    ? raw.deviceId.trim()
    : undefined;
  return {
    mode,
    ...(deviceId ? { deviceId } : {}),
    allowRemoteFallback: typeof raw.allowRemoteFallback === "boolean"
      ? raw.allowRemoteFallback
      : DEFAULT_CHAT_WORKSPACE_RUNTIME_PREFERENCE.allowRemoteFallback,
  };
}
