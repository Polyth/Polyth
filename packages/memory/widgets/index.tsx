import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import MemorySettings from "./MemorySettings.tsx";
import { ChatMemoryScope, InvitationNotice, ShareProposalCard } from "./MyNotes.tsx";

export default defineWebPackage((host) => () => {
  const translate = host.ui.locale.translate;
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
      id: "memory.share-proposals",
      slot: "composer.pending",
      order: 5,
      render: (props) => props.privateAmongOthers === true
        ? <ShareProposalCard projectId={typeof props.projectId === "string" ? props.projectId : null} sessionId={typeof props.sessionId === "string" ? props.sessionId : null} working={props.working === true} translate={translate} />
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
