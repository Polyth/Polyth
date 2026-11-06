// Who can read the chat on screen, said plainly wherever a Space has more than
// one person. Names come from the server on open; the row itself says only
// whether anyone else can read it, so it never guesses.
import { useEffect, useState } from "react";
import type { SessionProjection, SessionPerson } from "@polyth/contracts";
import { tr } from "../i18n/index.ts";
import { continuePrivately } from "../privateRoom.ts";
import { loadSessionSharing, ownerName } from "../sessionSharing.ts";
import SlotHost from "./slots/SlotHost.ts";
import { Button, Icon, LockIcon, SharedIcon } from "./ui/index.ts";
import "./PrivateRoomSwitch.css";

export function ChatAudienceLine({ session }: { session: SessionProjection }) {
  const sharing = session.sharing;
  const [readers, setReaders] = useState<readonly SessionPerson[] | null>(null);
  const shouldShow = sharing?.multiPerson === true;
  const shared = sharing?.shared === true;
  useEffect(() => {
    if (!shouldShow || !shared) { setReaders(null); return; }
    let live = true;
    void loadSessionSharing(session.id)
      .then((dto) => { if (live) setReaders(dto.readers ?? null); })
      .catch(() => { if (live) setReaders(null); });
    return () => { live = false; };
  }, [session.id, shared, shouldShow, sharing?.visibility]);
  if (!shouldShow) return null;
  const label = !shared
    ? tr("audience.onlyYou")
    : readers?.length
      ? tr("audience.readers", { names: readers.map(ownerName).join(", ") })
      : tr("audience.shared");
  return (
    <div className="chat-audience-line" data-chat-audience={shared ? "shared" : "private"}>
      <Icon icon={shared ? SharedIcon : LockIcon} size="sm" />
      <div className="chat-audience-copy">
        <span className="chat-audience-text" title={label}>{label}</span>
        <SlotHost slot="session.audience.details" context={{ projectId: session.projectId, sessionId: session.id, privateChat: !shared }} />
      </div>
      {shared && sharing?.access !== "view" && (
        <Button size="sm" variant="ghost" className="chat-audience-action" iconStart={LockIcon} aria-label={tr("privateRoom.continue")} onClick={() => void continuePrivately(session)}>
          <span className="chat-audience-action-label">{tr("privateRoom.continue")}</span>
        </Button>
      )}
    </div>
  );
}
