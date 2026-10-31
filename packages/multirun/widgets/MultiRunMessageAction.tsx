// Message quick action: seed Multi-run with this message and open its pane.
// Contributed through `session.message.actions`; the host owns placement,
// ordering and visibility, so a disabled package simply never registers it. In
// the "More" menu the host keeps this mounted without a trigger and signals a
// selection through `messageActionRequest`.
import { useEffect, useRef, useState } from "react";
import { seedMultiRunPrompt } from "./multirunSeed.ts";
import ChatActionButton from "../../../apps/web/src/components/ChatActionButton.tsx";
import { CheckIcon, CombineIcon } from "../../../apps/web/src/components/ui/index.ts";

export default function MultiRunMessageAction({
  text,
  label,
  openPane,
  messageActionPlacement,
  messageActionRequest,
}: {
  text: string;
  label: string;
  openPane: () => void;
  messageActionPlacement?: unknown;
  messageActionRequest?: unknown;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inMenu = messageActionPlacement === "menu";
  const request = typeof messageActionRequest === "number" ? messageActionRequest : 0;
  const seenRequest = useRef(request);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const run = () => {
    seedMultiRunPrompt(text);
    openPane();
    setConfirmed(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setConfirmed(false); timer.current = null; }, 1_000);
  };

  useEffect(() => {
    if (request === seenRequest.current) return;
    seenRequest.current = request;
    if (inMenu) run();
    // The request counter is the only menu trigger; `run` reads the latest text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  if (inMenu) return null;
  return (
    <ChatActionButton
      icon={confirmed ? CheckIcon : CombineIcon}
      label={label}
      className={confirmed ? "chat-action-button--confirmed" : undefined}
      data-action-id="multirun.message-action"
      onClick={run}
    />
  );
}
