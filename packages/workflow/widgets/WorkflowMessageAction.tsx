import { createElement } from "react";
import type { AttachmentRef } from "@polyth/contracts";
import WorkflowLauncher from "./WorkflowLauncher.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";

/** Whether a message can be run in a workflow (also gates its "More" entry). */
export function workflowMessageActionAvailable(props: Readonly<Record<string, unknown>>): boolean {
  return typeof props.projectId === "string" && props.projectId !== ""
    && typeof props.messageText === "string" && props.messageText.trim() !== "";
}

/** Message actions get their own launcher instance so opening one cannot
 * replace or consume the live composer draft. In the message's "More" menu
 * the launcher has no trigger and opens on the host's selection request. */
export default function WorkflowMessageAction(props: Record<string, unknown>) {
  const projectId = typeof props.projectId === "string" ? props.projectId : undefined;
  const spaceId = typeof props.spaceId === "string" ? props.spaceId : undefined;
  const sessionId = typeof props.sessionId === "string" ? props.sessionId : undefined;
  const messageText = typeof props.messageText === "string" ? props.messageText : "";
  const sourceMessageSeq = typeof props.eventSeq === "number" ? props.eventSeq : undefined;
  if (!workflowMessageActionAvailable(props)) return null;
  const inMenu = props.messageActionPlacement === "menu";
  return createElement(WorkflowLauncher, {
    projectId,
    spaceId,
    sessionId,
    draftText: messageText,
    workflowAttachments: Array.isArray(props.attachments) ? props.attachments as AttachmentRef[] : [],
    sourceMessageSeq,
    lazy: true,
    subscribeToRequests: false,
    triggerLabel: tr("workflowlauncher.runInWorkflow"),
    trigger: inMenu ? "none" : "message",
    openRequest: typeof props.messageActionRequest === "number" ? props.messageActionRequest : 0,
    ...(typeof props.messageActionAnchor === "function"
      ? { anchor: props.messageActionAnchor as () => HTMLElement | null }
      : {}),
  });
}
