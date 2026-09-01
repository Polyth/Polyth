import { useState } from "react";
import {
  GROUP_ORDER,
  TECHNICAL_GROUP_LABEL,
  capabilityGroup,
  type ResolvedCapability,
} from "../capabilities.ts";
import { toggleCapability } from "../builtinCapabilities.ts";
import { tr } from "../i18n/index.ts";

interface CapabilityMenuProps {
  id: string;
  capabilities: ResolvedCapability[];
  onClose: () => void;
  className?: string;
  collapseTechnical?: boolean;
  manageAction?: () => void;
}

/** Shared grouped disclosure panel for capability launchers.
 *
 * This is a disclosure rather than an ARIA menu: its contents are ordinary
 * buttons in labelled groups, so native Tab navigation is the complete
 * keyboard contract. The optional Technical section is a nested disclosure.
 */
export default function CapabilityMenu({
  id,
  capabilities,
  onClose,
  className,
  collapseTechnical = false,
  manageAction,
}: CapabilityMenuProps) {
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const groups = GROUP_ORDER
    .map((label) => ({
      label,
      items: capabilities.filter((capability) => capabilityGroup(capability.descriptor.id) === label),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <div id={id} className={className} role="group" aria-label={tr("capabilitymenu.moreTools")}>
      {groups.map((group, groupIndex) => {
        const labelId = `${id}-group-${groupIndex}`;
        const itemsId = `${labelId}-items`;
        const technicalDisclosure = collapseTechnical && group.label === TECHNICAL_GROUP_LABEL;
        return (
          <div className="more-tools-group" role="group" aria-labelledby={labelId} key={group.label}>
            {technicalDisclosure ? (
              <button
                id={labelId}
                type="button"
                className="more-tools-group-head"
                aria-expanded={technicalOpen}
                aria-controls={itemsId}
                onClick={() => setTechnicalOpen((open) => !open)}
              >
                <span className="more-tools-group-arrow" aria-hidden="true">{technicalOpen ? "▾" : "▸"}</span>
                {group.label}
              </button>
            ) : (
              <div id={labelId} className="more-tools-group-label">{group.label}</div>
            )}
            {(!technicalDisclosure || technicalOpen) && (
              <div id={itemsId}>
                {group.items.map((capability) => {
                  const available = capability.descriptor.available();
                  const reason = available
                    ? null
                    : capability.descriptor.unavailableReason?.() ?? tr("capabilitymenu.unavailableRightNow");
                  const alias = capability.descriptor.technicalLabel
                    && capability.descriptor.technicalLabel !== capability.descriptor.label
                    ? ` (${capability.descriptor.technicalLabel})`
                    : "";
                  return (
                    <button
                      key={capability.descriptor.id}
                      type="button"
                      className="more-tools-item"
                      disabled={!available}
                      title={reason ?? capability.descriptor.plainDescription}
                      onClick={() => {
                        onClose();
                        toggleCapability(capability.descriptor.id, capability.descriptor.open);
                      }}
                    >
                      <span>{capability.descriptor.label}{alias}</span>
                      {!available && reason && <span className="more-tools-reason">{reason}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {manageAction && (
        <button
          type="button"
          className="strip-picker-manage"
          onClick={() => {
            onClose();
            manageAction();
          }}
        >
          {tr("capabilitymenu.manageInSettings")}</button>
      )}
    </div>
  );
}
