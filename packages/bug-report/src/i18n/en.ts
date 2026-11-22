/**
 * Canonical English messages owned by the bug-report package. Every other
 * locale in this directory is checked against these keys.
 */
export const en = {
  "bugreport.title": "Report a bug",
  "bugreport.description": "Send the Polyth team a screenshot of this window, the build and its settings, with your note.",
  "bugreport.intro": "It goes to the Polyth team's private bug tracker. Nothing leaves this computer until you press Send.",
  "bugreport.textLabel": "What went wrong? (optional)",
  "bugreport.textPlaceholder": "What you did, what you expected, and what happened instead",
  "bugreport.screenshot": "Include a screenshot of this window",
  "bugreport.screenshotAlt": "Screenshot of this window as it will be sent",
  "bugreport.screenshotMissing": "This window could not be captured; the report goes without a screenshot.",
  "bugreport.errors": "Include recent error messages ({count})",
  "bugreport.contactLabel": "GitHub username for follow-up (optional)",
  "bugreport.passwordLabel": "Tester password",
  "bugreport.passwordHint": "Asked once. This computer keeps it sealed by the system keychain.",
  "bugreport.passwordHintSession": "This computer has no system keychain, so the password is kept only until Polyth restarts. Reports waiting offline go once you enter it again.",
  "bugreport.passwordWrong": "That password was not accepted. Check it and try again.",
  "bugreport.details": "What will be sent",
  "bugreport.cancel": "Cancel",
  "bugreport.send": "Send report",
  "bugreport.sentTitle": "Report sent",
  "bugreport.sentBody": "Thank you. It is report #{issue}.",
  "bugreport.addedBody": "Thank you. It was added to report #{issue}, which describes the same problem.",
  "bugreport.queuedTitle": "Report saved",
  "bugreport.queuedBody": "The report service cannot be reached right now. Polyth sends it later by itself.",
  "bugreport.rate": "This computer has sent many reports in a short time. Try again in a minute.",
  "bugreport.version": "This build is not a published nightly, so it cannot send reports.",
  "bugreport.invalid": "The report could not be prepared. Copy the details and tell the team.",
  "bugreport.unavailable": "Bug reports are off on this build.",
  "bugreport.openFailed": "Could not start a bug report.",
} as const;

export type BugReportMessageKey = keyof typeof en;
export type BugReportMessages = Record<BugReportMessageKey, string>;
