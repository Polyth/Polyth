/**
 * Canonical English messages owned by the handoff package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "handoff.chip.via": "via {provider}",
  "handoff.chip.source": "Source: {provider} / {profile}",
  "handoff.chip.imported": "Imported: {imported}",
  "handoff.chip.bundle": "Context bundle: {bundle}",
  "handoff.chip.menuLabel": "Import source",
  "handoff.chip.menuDescription": "Shows which chat an imported result came from.",

  "handoff.status.agent": "Agent",
  "handoff.status.working": "Working",
  "handoff.status.waiting": "Waiting",
  "handoff.status.idle": "Idle",

  "handoff.drawer.close": "Close",
  "handoff.drawer.estimate": "Estimated {tokens} tokens",
  "handoff.drawer.preview": "Preview",
  "handoff.drawer.copy": "Copy",
  "handoff.drawer.previewTokens": "Preview · {tokens} tokens",
  "handoff.drawer.edit": "Edit",
  "handoff.drawer.exportMd": "Export .md",
  "handoff.drawer.previewTitle": "Context preview · {tokens}",
  "handoff.drawer.large": "Context is very large · {tokens} tokens",
  "handoff.drawer.removeSection": "Remove section",
  "handoff.drawer.notePlaceholder": "Add a note",
  "handoff.drawer.files": "Files",
  "handoff.drawer.changedFiles": "Changed files",
  "handoff.drawer.selectFiles": "Select files",
  "handoff.drawer.instruction": "Instruction",
  "handoff.drawer.omission": "{total} {label} · {included} included · {omitted} omitted ({reason})",

  "handoff.source.task": "Task",
  "handoff.source.taskDescription": "Latest user prompt in the session",
  "handoff.source.sessionSummary": "Session summary",
  "handoff.source.sessionSummaryDescription": "Compact digest of session state (not full transcript)",
  "handoff.source.sessionErrors": "Logs",
  "handoff.source.sessionErrorsDescription": "Recent tool/runtime errors from the session log",
  "handoff.source.note": "Custom note",
  "handoff.source.noteDescription": "Freeform note supplied when building the bundle",

  "handoff.send.title": "Send to Polyth",
  "handoff.send.textAria": "Handoff text",
  "handoff.send.destination": "Destination",
  "handoff.send.queueCurrent": "Queue in current session",
  "handoff.send.sendCurrent": "Send to current session",
  "handoff.send.idleSession": "Idle session",
  "handoff.send.saveDraft": "Save draft",
  "handoff.send.queue": "Queue",
  "handoff.send.send": "Send",
  "handoff.send.cancel": "Cancel",

  "handoff.error.targetUnavailable": "Handoff target “{target}” is not available",
} as const;

export type HandoffMessageKey = keyof typeof en;
export type HandoffMessages = Record<HandoffMessageKey, string>;
