/**
 * Canonical English messages owned by the secure-safe package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "packages.secureSafe.secureSafeCredentials": "Secure Safe credentials",
  "packages.secureSafe.writeOnlyCredentialValuesStoredBehindReusable": "Write-only credential values stored behind reusable handles",
  "securesafecard.credentialValue": "Credential value",
  "securesafecard.credentialValueForValue": "Credential value for {label}",
  "securesafecard.dismiss": "Dismiss",
  "securesafecard.enterValueItWillNotBeShown": "Enter value — it will not be shown again",
  "securesafecard.handle": "Handle",
  "securesafecard.label": "Label",
  "securesafecard.purpose": "Purpose",
  "securesafecard.saveToSecureSafe": "Save to Secure Safe",
  "securesafecard.secureSafeSaveCredential": "Secure Safe — save credential",
  "securesafecard.submitted": "Submitted",
  "securesafecard.willUpdateExistingHandle": "Will update existing handle",
  "settings.securesafepage.addACredentialBelowOrRespondToAn": "Add a credential below or respond to an agent request in chat.",
  "settings.securesafepage.addCredential": "Add credential",
  "settings.securesafepage.addToSecureSafe": "Add to Secure Safe",
  "settings.securesafepage.agentsMayRequestOrReferenceAHandle": "Agents may request or reference a handle, but cannot read its value. Never put credential values in prompts,",
  "settings.securesafepage.agentsMd": "AGENTS.md",
  "settings.securesafepage.credentialValue": "Credential value",
  "settings.securesafepage.deleteSecureSafeHandle": "Delete Secure Safe handle",
  "settings.securesafepage.deleteTheSecureSafeHandleValue": "Delete the Secure Safe handle \"{handle}\"?",
  "settings.securesafepage.deployToken": "deploy-token",
  "settings.securesafepage.deploymentToken": "Deployment token",
  "settings.securesafepage.handle": "Handle",
  "settings.securesafepage.label": "Label",
  "settings.securesafepage.loadingHandles": "Loading handles…",
  "settings.securesafepage.noSavedHandles": "No saved handles",
  "settings.securesafepage.optional": "(optional)",
  "settings.securesafepage.orProjectConfiguration": ", or project configuration.",
  "settings.securesafepage.purpose": "Purpose",
  "settings.securesafepage.savedHandles": "Saved handles (",
  "settings.securesafepage.secureSafe": "Secure Safe",
  "settings.securesafepage.storeCredentialsBehindReusableHandlesValuesAre": "Store credentials behind reusable handles. Values are write-only and never returned by the API.",
  "settings.securesafepage.theValueIsClearedAsSoonAs": "The value is cleared as soon as it is submitted.",
  "settings.securesafepage.usedForProductionDeployments": "Used for production deployments",
  "settings.securesafepage.writeOnlyValue": "Write-only value",
} as const;

export type SecureSafeMessageKey = keyof typeof en;
export type SecureSafeMessages = Record<SecureSafeMessageKey, string>;
