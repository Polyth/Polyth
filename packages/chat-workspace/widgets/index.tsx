import "./styles.css";
import { createElement } from "react";
import { defineWebPackage, type WebPackageHost } from "@polyth/web-sdk";
import { createApiTransport } from "@polyth/web-sdk";
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";
import ChatWorkspaceRuntimeShell from "./ChatWorkspaceRuntimeShell.tsx";
import ChatWorkspaceSettingsPage from "./ChatWorkspaceSettingsPage.tsx";
import { createChatWorkspaceCommands } from "./lib/commands.ts";
import { enqueueChatWorkspaceCommand, type CopyContextResult } from "./lib/pendingCommands.ts";

const transport = createApiTransport();

function commandContext(host: WebPackageHost) {
  const snap = host.store.getSnapshot();
  return { projectId: snap.activeProjectId, sessionId: snap.activeSessionId };
}

export default defineWebPackage((host) => () => {
  const commands = createChatWorkspaceCommands({
    host,
    transport,
    getProjectId: () => host.store.getSnapshot().activeProjectId,
    getSessionId: () => host.store.getSnapshot().activeSessionId,
    copyBundle: (): CopyContextResult => {
      const ctx = commandContext(host);
      if (!ctx.projectId) return "unavailable";
      return enqueueChatWorkspaceCommand({ kind: "copy-bundle" }, ctx);
    },
    onPreparedBundle: (input) => {
      enqueueChatWorkspaceCommand({
        kind: "show-prepared-bundle",
        bundle: input.bundle,
        ...input.drawer,
      }, { projectId: input.bundle.projectId, sessionId: input.bundle.sessionId });
    },
    onPasteOpen: () => {
      enqueueChatWorkspaceCommand({ kind: "open-paste" }, commandContext(host));
    },
    onNoSession: () => {
      enqueueChatWorkspaceCommand({ kind: "notify", message: "Open a session to build Polyth context" }, commandContext(host));
    },
    onNoBundle: () => {
      enqueueChatWorkspaceCommand({ kind: "notify", message: "Prepare context first — open Chat Workspace and build a bundle." }, commandContext(host));
    },
  });

  const off = [
    host.surfaces.register({
      id: "chat-workspace",
      title: "Chat Workspace",
      description: "Use external AI chats alongside your Polyth work.",
      shortLabel: "Chats",
      capabilityId: "chat-workspace",
      order: 5,
      component: (props?: { active?: boolean }) => createElement(ChatWorkspaceRuntimeShell, {
        host,
        active: props?.active ?? true,
      }),
      presentation: withSurfaceContent({
        kind: "workspace",
        defaultRatio: 0.45,
        minWidth: 380,
        preferredMaxWidth: 760,
        keepAlive: true,
        escape: "content",
        dock: "side",
      }, "workspace"),
    }),
    host.capabilities.register({
      id: "chat-workspace",
      label: "Chat Workspace",
      plainDescription: "Open external AI chat tabs next to your session.",
      keywords: ["chat", "chatgpt", "claude", "gemini", "workspace"],
      standardTier: "primary",
      standardRank: 4,
      open: () => { commands.openPane(); },
      available: () => true,
    }),
    host.settings.registerPage({
      id: "chat-workspace",
      packageId: "chat-workspace",
      label: "Chat Workspace",
      group: "Workspace",
      icon: "chat",
      order: 25,
      component: () => createElement(ChatWorkspaceSettingsPage, { host }),
      settingsItems: [
        { id: "chat-workspace.general", pageId: "chat-workspace", label: "General", keywords: ["chat workspace", "tabs"], focusTarget: "chat-workspace.general" },
        { id: "chat-workspace.profiles", pageId: "chat-workspace", label: "Profiles", keywords: ["login", "session", "rename", "delete"], focusTarget: "chat-workspace.profiles" },
        { id: "chat-workspace.context-handoff", pageId: "chat-workspace", label: "Context & handoff", keywords: ["send", "queue", "tokens", "provenance"], focusTarget: "chat-workspace.context-handoff" },
        { id: "chat-workspace.performance", pageId: "chat-workspace", label: "Performance", keywords: ["hibernate", "streaming", "live tab limit"], focusTarget: "chat-workspace.performance" },
      ],
    }),
    host.slots.register({
      slot: "commandPalette.commands",
      id: "chat-workspace.palette",
      render: () => null,
      meta: {
        commands: [
          { id: "chat-workspace.open", label: "Chat Workspace: Open", group: "Chat Workspace", run: () => commands.openPane() },
          { id: "chat-workspace.review", label: "Chat Workspace: Review changes", group: "Chat Workspace", run: () => void commands.openPreset("review") },
          { id: "chat-workspace.debug", label: "Chat Workspace: Debug failure", group: "Chat Workspace", run: () => void commands.openPreset("debug") },
          { id: "chat-workspace.plan", label: "Chat Workspace: Plan implementation", group: "Chat Workspace", run: () => void commands.openPreset("plan") },
          { id: "chat-workspace.copy", label: "Chat Workspace: Copy context", group: "Chat Workspace", run: () => void commands.copyContext() },
          { id: "chat-workspace.paste", label: "Chat Workspace: Paste result", group: "Chat Workspace", run: () => void commands.pasteResult() },
          ...commands.providerCommands,
        ],
      },
    }),
    host.slots.register({
      slot: "session.header.actions",
      id: "chat-workspace.review",
      render: ({ projectId, sessionId }) => projectId && sessionId ? createElement(host.ui.components.Button, {
        size: "sm",
        variant: "ghost",
        onClick: () => { void commands.openPreset("review"); },
      }, "Review in Chat Workspace") : null,
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
