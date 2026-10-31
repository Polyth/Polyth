import { defineWebPackage } from "@polyth/web-sdk";
import { FindDialogHost, FindLauncher } from "./ConversationFind.tsx";
import { createFindController } from "./controller.ts";
import { findStrings } from "./strings.ts";
import "./styles.css";

export default defineWebPackage((host) => () => {
  const controller = createFindController();
  const strings = findStrings(host.ui.locale.get());
  const open = () => {
    const sessionId = host.store.getSnapshot().activeSessionId;
    if (!sessionId) return;
    host.navigation.setActiveView("session");
    controller.open(sessionId);
  };
  const off = [
    host.store.subscribe(() => {
      const target = controller.getSnapshot();
      if (target && host.store.getSnapshot().activeSessionId !== target.sessionId) controller.close();
    }),
    // Hosts the modal for the shortcut/command path. It renders nothing until
    // find is opened, so the chat shows no always-visible launcher.
    host.slots.register({
      id: "conversation.find-dialog", slot: "session.composer.before", order: -10,
      render: () => <FindDialogHost host={host} controller={controller} />,
    }),
    host.capabilities.register({
      id: "conversation-find", label: strings.find, plainDescription: strings.empty,
      keywords: ["find", "conversation", "message", "search", "text"],
      rail: false, launcherWidget: false, standardTier: "more", standardRank: 0, open,
      available: () => host.store.getSnapshot().activeSessionId !== null,
    }),
    host.widgets.registerPlugin({
      id: "conversation",
      name: "Conversation",
      widgets: [{
        id: "conversation.find",
        title: strings.find,
        description: strings.widgetDescription,
        kind: "mini-widget",
        defaultSlot: "composer.leading",
        // Acts on the agent's turn: hidden where the composer writes only to people.
        agentOnly: true,
        supportedSlots: ["composer.leading", "composer.trailing", "workspace.header", "workspace.main", "workspace.right", "workspace.bottom"],
        category: "Workspace",
        defaultVisible: false,
        audience: "standard",
        resizable: false,
        defaultSize: { w: 1, h: 1 },
        render: (context) => (
          <FindLauncher host={host} controller={controller}
            sessionId={typeof context.sessionId === "string" ? context.sessionId : null} />
        ),
      }],
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
