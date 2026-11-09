import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import MemorySettings from "./MemorySettings.tsx";
import { ChatMemoryScope, InvitationNotice, ShareOffer, type Notify } from "./MyNotes.tsx";

export default defineWebPackage((host) => () => {
  const translate = host.ui.locale.translate;
  const notify: Notify = (input) => host.notifications?.show(input);
  const slots = [
    host.slots.register({
      id: "memory.chat-scope",
      slot: "composer.context.details",
      order: 20,
      // Only among other people: alone, there is nothing to tell apart.
      render: (props) => typeof props.privateChat === "boolean"
        ? <ChatMemoryScope
            privateChat={props.privateChat}
            translate={translate}
            onOpenNotes={typeof props.projectId === "string" ? () => {
              if (typeof props.closeCard === "function") props.closeCard();
              host.projectSettings.open?.(props.projectId as string, "memory");
            } : undefined}
          />
        : null,
    }),
    host.slots.register({
      id: "memory.share-offer",
      slot: "session.timeline.after",
      order: 3,
      render: (props) => props.privateAmongOthers === true && typeof props.projectId === "string" && typeof props.sessionId === "string"
        ? <ShareOffer
            projectId={props.projectId}
            sessionId={props.sessionId}
            settled={props.turnStatus !== "working"}
            latestPromptAt={typeof props.latestPromptAt === "number" ? props.latestPromptAt : 0}
            translate={translate}
            notify={notify}
          />
        : null,
    }),
    host.slots.register({
      id: "memory.invitation-notice",
      slot: "settings.users.invite.notice",
      render: () => <InvitationNotice translate={translate} />,
    }),
  ];
  const unregister = host.projectSettings.register({
    id: "memory",
    order: 30,
    label: host.ui.locale.translate("memory.name"),
    description: host.ui.locale.translate("memory.description"),
    icon: "brain",
    visible: () => true,
    render: ({ projectId, project, mobile, onBack, onClose }) => (
      <MemorySettings
        projectId={projectId}
        project={project}
        mobile={mobile}
        locale={host.ui.locale.get()}
        translate={host.ui.locale.translate}
        notify={notify}
        onBack={onBack}
        onClose={onClose}
      />
    ),
  });
  return () => {
    unregister();
    for (const dispose of slots) dispose();
  };
});
