// Who else reads the chat on screen, said only when someone does: a quiet label
// in the composer's model row that opens the chat's sharing. A chat only its
// person can read says nothing.
import { useEffect, useState } from "react";
import type { SessionPerson, SessionProjection } from "@polyth/contracts";
import { tr } from "../i18n/index.ts";
import { chatReadByOthers } from "../privateRoom.ts";
import { loadSessionSharing, ownerName } from "../sessionSharing.ts";
import { openSessionSharing } from "../store.ts";
import { Icon, SharedIcon } from "./ui/index.ts";

export function ChatAudienceChip({ session }: { session: SessionProjection }) {
  const speaks = chatReadByOthers(session);
  const [readers, setReaders] = useState<readonly SessionPerson[] | null>(null);
  useEffect(() => {
    if (!speaks) { setReaders(null); return; }
    let live = true;
    void loadSessionSharing(session.id)
      .then((dto) => { if (live) setReaders(dto.readers ?? null); })
      .catch(() => { if (live) setReaders(null); });
    return () => { live = false; };
  }, [session.id, speaks, session.sharing?.visibility]);
  if (!speaks) return null;
  const names = readers?.map(ownerName).join(", ");
  const label = names ? tr("audience.readers", { names }) : tr("audience.shared");
  return (
    <button type="button" className="config-chip composer-audience" title={label} aria-label={label} onClick={() => openSessionSharing(session.id)}>
      <Icon icon={SharedIcon} size="sm" />
      <span className="composer-audience-label">{label}</span>
      {names && <span className="composer-audience-names">{names}</span>}
    </button>
  );
}
