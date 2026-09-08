import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChatProfileDto, ChatWorkspaceDto, ChatWorkspaceSettingsDto } from "@polyth/contracts";
import type { SpaceStorage } from "@polyth/contracts";

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export const DEFAULT_SETTINGS: ChatWorkspaceSettingsDto = {
  liveTabLimit: 4,
  hibernateDelayMs: 15 * 60_000,
  streamQuality: 60,
  warnTokenThreshold: 80_000,
  defaultProviderId: "chatgpt",
  defaultTarget: "current-session",
  externalLinkBehavior: "prompt",
  restoreLastTabs: true,
};

export function profileRoot(storage: SpaceStorage, userId: string, profileId: string): string {
  return storage.path(join("packages", "chat-workspace", "profiles", userId, profileId));
}

export async function loadProfile(storage: SpaceStorage, userId: string, profileId: string): Promise<ChatProfileDto | null> {
  try {
    const raw = await readFile(join(profileRoot(storage, userId, profileId), "profile.json"), "utf8");
    return JSON.parse(raw) as ChatProfileDto;
  } catch {
    return null;
  }
}

export async function saveProfile(storage: SpaceStorage, userId: string, profile: ChatProfileDto): Promise<void> {
  const dir = profileRoot(storage, userId, profile.id);
  await mkdir(join(dir, "chromium"), { recursive: true });
  await writeFile(join(dir, "profile.json"), `${JSON.stringify(profile, null, 2)}\n`);
}

export async function listProfiles(storage: SpaceStorage, userId: string): Promise<ChatProfileDto[]> {
  const root = storage.path(join("packages", "chat-workspace", "profiles", userId));
  try {
    const ids = await readdir(root);
    const profiles = await Promise.all(ids.map((id) => loadProfile(storage, userId, id)));
    return profiles.filter((p): p is ChatProfileDto => p !== null);
  } catch {
    return [];
  }
}

export async function deleteProfile(storage: SpaceStorage, userId: string, profileId: string): Promise<void> {
  await rm(profileRoot(storage, userId, profileId), { recursive: true, force: true });
}

export async function loadWorkspace(storage: SpaceStorage, projectId: string): Promise<ChatWorkspaceDto> {
  const path = storage.path(join("packages", "chat-workspace", "projects", projectId, "workspace.json"));
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as ChatWorkspaceDto;
  } catch {
    return { tabs: [], activeTabId: null, order: [] };
  }
}

export async function saveWorkspace(storage: SpaceStorage, projectId: string, workspace: ChatWorkspaceDto): Promise<void> {
  const dir = storage.path(join("packages", "chat-workspace", "projects", projectId));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "workspace.json"), `${JSON.stringify(workspace, null, 2)}\n`);
}

export async function loadSettings(storage: SpaceStorage): Promise<ChatWorkspaceSettingsDto> {
  const path = storage.path(join("packages", "chat-workspace", "settings.json"));
  try {
    const raw = await readFile(path, "utf8");
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as ChatWorkspaceSettingsDto) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(storage: SpaceStorage, settings: ChatWorkspaceSettingsDto): Promise<void> {
  const dir = storage.packageDir("chat-workspace");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

export function spaceKey(spaceId: string, id: string): string {
  return `${spaceId}:${id}`;
}

export { err };
