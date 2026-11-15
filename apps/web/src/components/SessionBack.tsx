// Back from the open chat. A delegated child (a subagent, a workflow unit) goes
// back to its parent chat; any other chat offers the `session.header.back`
// slot, where the package that owns the session draws its own Back (an
// agent's session goes back to its agent). Both use one control,
// `SessionBackButton`, so the way back looks the same wherever it leads.
import { displayWideSessionTitle } from "../format.ts";
import { openSession } from "../init.ts";
import { useStore } from "../store.ts";
import { firstUserTextCached } from "../utils.ts";
import SlotHost from "./slots/SlotHost.ts";
import SessionBackButton, { type SessionBackPresentation } from "./ui/SessionBackButton.tsx";

export default function SessionBack({ sessionId, presentation }: { sessionId: string; presentation: SessionBackPresentation }) {
  const parentId = useStore((state) => state.sessions.find((session) => session.id === sessionId)?.parentId);
  // Only a parent this person can open: a child whose parent is not in their
  // list (archived, another person's) keeps the package slot instead.
  const parent = useStore((state) => parentId ? state.sessions.find((session) => session.id === parentId) ?? null : null);
  const parentEvents = useStore((state) => parentId ? state.events[parentId] : undefined);
  if (parent) {
    const label = displayWideSessionTitle(parent.title, parent.titleSource, parent.id, firstUserTextCached(parentEvents));
    return <SessionBackButton presentation={presentation} label={label} onBack={() => { void openSession(parent.id); }} />;
  }
  return <SlotHost slot="session.header.back" context={{ sessionId, presentation }} />;
}
