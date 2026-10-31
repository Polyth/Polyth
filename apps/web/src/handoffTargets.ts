import type { HandoffTargetRegistration } from "@polyth/web-sdk";
import { sendMessage } from "./init.ts";
import { requestComposerReplace } from "./composerInsert.ts";
import { getState, startNewSession } from "./store.ts";
import { tr } from "./i18n/index.ts";

const targets = new Map<string, HandoffTargetRegistration>();

export function registerHandoffTarget(registration: HandoffTargetRegistration): () => void {
  targets.set(registration.id, registration);
  return () => { targets.delete(registration.id); };
}

export function listHandoffTargets(): HandoffTargetRegistration[] {
  return [...targets.values()];
}

export function installDefaultHandoffTargets(): () => void {
  const off = [
    registerHandoffTarget({
      id: "current-session",
      // Read on every render, so a language switch shows at once.
      get label() { return tr("handofftargets.sendNow"); },
      available: () => Boolean(getState().activeSessionId),
      async send(input) {
        await sendMessage(input.text);
      },
    }),
    registerHandoffTarget({
      id: "queue",
      get label() { return tr("handofftargets.queue"); },
      available: () => Boolean(getState().activeSessionId),
      async send(input) {
        await sendMessage(input.text, undefined, undefined, { delivery: "queue" });
      },
    }),
    registerHandoffTarget({
      id: "new-session",
      get label() { return tr("handofftargets.newSession"); },
      available: () => Boolean(inputProjectId()),
      async send(input) {
        await startNewSession(input.projectId);
        requestComposerReplace(input.text);
      },
    }),
    registerHandoffTarget({
      id: "draft",
      get label() { return tr("handofftargets.draft"); },
      available: () => Boolean(getState().activeSessionId),
      async send(input) {
        requestComposerReplace(input.text);
      },
    }),
  ];
  return () => off.forEach((dispose) => dispose());
}

function inputProjectId(): string | null {
  return getState().activeProjectId;
}
