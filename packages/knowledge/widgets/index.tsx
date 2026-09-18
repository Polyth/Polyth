import "./styles.css";
import { createApiTransport, defineWebPackage, type WebPackageHost } from "@polyth/web-sdk";
import { createElement } from "react";
import KnowledgePanel from "./KnowledgePanel.tsx";
import TracksPanel from "./TracksPanel.tsx";

const api = createApiTransport();

function SavePlanResponseAction({
  host,
  context,
}: {
  host: WebPackageHost;
  context: Record<string, unknown>;
}) {
  const actions = Array.isArray(context.responseActions) ? context.responseActions : [];
  const projectId = typeof context.projectId === "string" ? context.projectId : "";
  const sessionId = typeof context.sessionId === "string" ? context.sessionId : "";
  const text = typeof context.messageText === "string" ? context.messageText : "";
  const modelName = typeof context.messageModelName === "string" ? context.messageModelName : "Assistant";
  const announce = typeof context.announce === "function"
    ? context.announce as (message: string) => void
    : undefined;
  if (!actions.includes("plan") || !projectId || !text) return null;

  const IconButton = host.ui.components.IconButton;
  const label = host.ui.locale.translate("timeline.saveAsPlan");
  return createElement(IconButton, {
    icon: host.ui.icons.plan,
    label,
    size: "sm",
    variant: "ghost",
    className: "chat-action-button",
    onClick: () => {
      void api.post("/api/knowledge", {
        projectId,
        kind: "plan",
        title: `${host.ui.locale.translate("knowledgepanel.plan")} · ${modelName}`,
        body: text,
        ...(sessionId ? { sourceSessionId: sessionId } : {}),
      }).then(() => announce?.(host.ui.locale.translate("timeline.answerSavedAsAPlan")))
        .catch((cause) => host.errors.show?.(host.errors.friendly("Save as plan", cause)));
    },
  });
}

export default defineWebPackage((host) => () => {
  const presentation = {
    kind: "workspace" as const,
    defaultRatio: 0.6,
    minWidth: 320,
    preferredMaxWidth: 760,
    keepAlive: true as const,
    escape: "close" as const,
  };
  const off = [
    host.surfaces.register({
      id: "knowledge",
      title: "Knowledge",
      description: "Browse notes and references Polyth can use.",
      capabilityId: "knowledge",
      order: 40,
      component: KnowledgePanel,
      presentation,
    }),
    host.surfaces.register({
      id: "tracks",
      title: "Tracks",
      description: "Execute a saved feature specification.",
      capabilityId: "tracks",
      order: 41,
      component: () => createElement(TracksPanel),
      presentation,
    }),
    host.capabilities.register({
      id: "knowledge",
      label: "Knowledge",
      plainDescription: "Notes and references Polyth can use.",
      keywords: ["knowledge", "notes", "docs"],
      standardTier: "more",
      standardRank: 17,
      open: () => host.navigation.openWorkspacePane("knowledge"),
      available: () => true,
    }),
    host.capabilities.register({
      id: "tracks",
      label: "Tracks",
      technicalLabel: "Spec-driven tracks",
      plainDescription: "Execute a saved feature specification.",
      keywords: ["track", "spec", "plan", "workflow"],
      standardTier: "more",
      standardRank: 18,
      open: () => host.navigation.openWorkspacePane("tracks"),
      available: () => true,
    }),
    host.slots.register({
      slot: "session.message.actions",
      id: "knowledge.save-plan-response",
      order: 25,
      render: (context) => createElement(SavePlanResponseAction, { host, context }),
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
