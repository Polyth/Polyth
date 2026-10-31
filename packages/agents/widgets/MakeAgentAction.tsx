import type { WebPackageHost } from "@polyth/web-sdk";
import { useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { AssistIcon, Icon } from "../../../apps/web/src/components/ui/index.ts";
import { offerAgentSeed } from "./agentSeed.ts";
import { openNewAgent } from "./agentActions.ts";

/** Session menu entry: turn a conversation that worked into an agent. The
 *  session's project, model and route seed the draft; the conversation itself
 *  is read by the server only when the user asks for a draft. */
export default function MakeAgentAction({ host, sessionId, closeMenu }: {
  host: WebPackageHost;
  sessionId: string;
  closeMenu?: () => void;
}) {
  const session = useStore((state) => state.sessions.find((item) => item.id === sessionId));
  // Package-owned purpose sessions (playgrounds, workflow parents) are not chats to automate.
  if (!session || session.purpose) return null;
  const open = () => {
    offerAgentSeed({
      projectId: session.projectId,
      sessionId: session.id,
      sessionTitle: session.title,
      ...(session.model ? { model: session.model } : {}),
      ...(session.harness?.mode === "pinned" ? { harness: session.harness } : {}),
    });
    closeMenu?.();
    openNewAgent(host, session.projectId);
  };
  return (
    <button type="button" role="menuitem" className="ui-menu-item" onClick={open}>
      <Icon icon={AssistIcon} size="sm" />
      <span className="ui-menu-item-copy"><span className="ui-menu-item-label">{tr("agents.makeAgent")}</span></span>
    </button>
  );
}
