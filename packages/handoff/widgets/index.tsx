import "./styles.css";
import { createElement, useRef, useState } from "react";
import { defineWebPackage, type MessageActionSlotMeta } from "@polyth/web-sdk";
import type { HandoffResultImportedData } from "@polyth/contracts";
import {
  getPairedProvenance,
  noteImportPending,
  pairUserMessage,
} from "../src/provenancePairing.ts";
import { flushNewSessionHandoffImport } from "../src/newSessionProvenance.ts";
import { HandoffIcon, Popover } from "../../../apps/web/src/components/ui/index.ts";

function ProvenanceChip(props: {
  sessionId: string;
  eventSeq: number;
  translate: (key: string, values?: Record<string, string | number>) => string;
  locale?: string;
}) {
  const paired = getPairedProvenance(props.sessionId, props.eventSeq);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  if (!paired) return null;
  const provider = paired.provenance.provider;
  const profile = paired.provenance.profileName;
  const imported = new Date(paired.importedAt).toLocaleString(props.locale);
  const bundleLabel = paired.provenance.bundleLabel;
  const t = props.translate;
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="handoff-provenance-chip"
        onClick={() => setOpen((v) => !v)}
      >
        {t("handoff.chip.via", { provider })}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef}>
        <div className="handoff-provenance-popover">
          <p>{t("handoff.chip.source", { provider, profile })}</p>
          <p>{t("handoff.chip.imported", { imported })}</p>
          {bundleLabel ? <p>{t("handoff.chip.bundle", { bundle: bundleLabel })}</p> : null}
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
        return createElement(ProvenanceChip, { sessionId, eventSeq, translate: host.ui.locale.translate, locale: host.ui.locale.get() });
      },
      // Listed with the quick actions so it can be moved or turned off. The
      // chip owns an anchored popover, so it stays on the bar.
      meta: {
        messageAction: {
          // Label and description are resolved on every render so a locale
          // switch stays live.
          label: () => host.ui.locale.translate("handoff.chip.menuLabel"),
          description: () => host.ui.locale.translate("handoff.chip.menuDescription"),
          icon: HandoffIcon,
          roles: ["user"],
        } satisfies MessageActionSlotMeta,
      },
    }),
    // A handoff imported into a brand-new session persists its provenance once
    // that session exists, before the first message is delivered.
    ...(host.composer?.registerSessionCreatedHook
      ? [host.composer.registerSessionCreatedHook({
          id: "handoff.new-session-import",
          run: ({ projectId, sessionId, text }) => flushNewSessionHandoffImport(projectId, sessionId, text),
        })]
      : []),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
