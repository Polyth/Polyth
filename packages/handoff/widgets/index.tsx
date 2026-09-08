import "./styles.css";
import { createElement, useRef, useState } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import type { HandoffResultImportedData } from "@polyth/contracts";
import {
  getPairedProvenance,
  noteImportPending,
  pairUserMessage,
} from "../src/provenancePairing.ts";
import { Popover } from "../../../apps/web/src/components/ui/index.ts";

function ProvenanceChip(props: {
  sessionId: string;
  eventSeq: number;
}) {
  const paired = getPairedProvenance(props.sessionId, props.eventSeq);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  if (!paired) return null;
  const provider = paired.provenance.provider;
  const profile = paired.provenance.profileName;
  const imported = new Date(paired.importedAt).toLocaleString();
  const bundleLabel = paired.provenance.bundleLabel;
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="handoff-provenance-chip"
        onClick={() => setOpen((v) => !v)}
      >
        via {provider}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef}>
        <div className="handoff-provenance-popover">
          <p>Source: {provider} / {profile}</p>
          <p>Imported: {imported}</p>
          {bundleLabel ? <p>Context bundle: {bundleLabel}</p> : null}
        </div>
      </Popover>
    </>
  );
}

export default defineWebPackage((host) => () => {
  const off = [
    host.reducers.register("handoff/result-imported", (_state, event) => {
      const data = event.data as unknown as HandoffResultImportedData;
      noteImportPending(event.sessionId, data.provenance, data.textHash, event.time);
    }),
    host.reducers.register("user/message", (_state, event) => {
      pairUserMessage(event);
    }),
    host.slots.register({
      slot: "session.message.actions",
      id: "handoff.provenance-chip",
      order: 50,
      render: (props) => {
        const { sessionId, eventSeq, kind } = props as {
          sessionId: string;
          eventSeq: number;
          kind: string;
        };
        if (kind !== "user") return null;
        return createElement(ProvenanceChip, { sessionId, eventSeq });
      },
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
