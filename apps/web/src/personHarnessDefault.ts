// The signed-in person's own default harness for new chats (Spaces §13).
// The server pins a new chat to it only when the create request names no
// harness, model or agent, so the new-chat composer must leave those out
// whenever nothing was chosen for the chat. Choosing the default happens in
// Settings → Harnesses (harness-runtime), which invalidates the runtime
// catalogs on save; callers pass that catalog revision so the cache follows.
import { useEffect, useState } from "react";
import type { DraftExecutionConfig, PersonHarnessDefaultDto } from "@polyth/contracts";
import { activeBrowserAccountId } from "./accountStorage.ts";
import type { ComposerConfig } from "./composerConfig.ts";

const cache = new Map<string, Promise<string | undefined>>();

/** The person's default harness id while it is usable in the current Space;
 *  undefined when unset, unusable, unknown to the server, or not loaded yet. */
export function readPersonHarnessDefault(key: string): Promise<string | undefined> {
  let pending = cache.get(key);
  if (!pending) {
    pending = fetch("/api/harnesses/default").then(async (response) => {
      if (!response.ok) return undefined;
      const body = await response.json() as Partial<PersonHarnessDefaultDto>;
      return body.usable === true && typeof body.harnessId === "string" ? body.harnessId : undefined;
    }).catch(() => {
      // A failed read is retried next time instead of hiding the default.
      cache.delete(key);
      return undefined;
    });
    cache.clear();
    cache.set(key, pending);
  }
  return pending;
}

export function usePersonHarnessDefault(spaceId: string | undefined, catalogRevision: number): string | undefined {
  const key = JSON.stringify([activeBrowserAccountId(), spaceId ?? "", catalogRevision]);
  const [value, setValue] = useState<{ key: string; harnessId: string | undefined }>();
  useEffect(() => {
    let live = true;
    void readPersonHarnessDefault(key).then((harnessId) => { if (live) setValue({ key, harnessId }); });
    return () => { live = false; };
  }, [key]);
  return value?.key === key ? value.harnessId : undefined;
}

/** Whether anything that decides where a new chat runs was chosen for it:
 *  a harness tab (Auto included), a model, thinking, an agent or an agent
 *  profile. Such a chat keeps its explicit route. */
export function newChatRouteChosen(draft: DraftExecutionConfig, cfg: ComposerConfig): boolean {
  return draft.harnessSelectionExplicit === true
    || draft.model !== undefined
    || draft.agent !== undefined
    || draft.profileId !== undefined
    || draft.thinking !== undefined
    || cfg.harness !== undefined
    || cfg.model !== undefined
    || cfg.agent !== undefined
    || cfg.thinking !== undefined
    || cfg.profile.kind === "id";
}

/** The person default a new chat follows, or undefined when it keeps the
 *  existing route (explicit pick, project default, Auto). */
export const newChatPersonDefault = (personDefaultHarnessId: string | undefined, routeChosen: boolean): string | undefined =>
  routeChosen ? undefined : personDefaultHarnessId;
