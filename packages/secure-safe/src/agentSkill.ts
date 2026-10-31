// Product skill: shipped with the Credential Vault package, never discovered
// from a user's HOME or project. Deployment-scoped so every Space/project
// inherits it. The legacy package id and capability id stay stable so existing
// Space/package composition and native overlays do not lose the contract.
import type { AgentCapabilityContribution } from "@polyth/contracts";

export const SECURE_SAFE_PACKAGE_ID = "secure-safe";

export const secureSafeSkill: AgentCapabilityContribution = {
  descriptor: {
    id: `${SECURE_SAFE_PACKAGE_ID}.skill.polyth-secure-safe`,
    kind: "skill",
    owner: SECURE_SAFE_PACKAGE_ID,
    scope: "deployment",
    revision: "2",
    name: "polyth-secure-safe",
    title: "Polyth Credential Vault",
    description: "Use only for tasks that need a stored credential or handle; never handle secret values in chat. The protected form collects the value while agents use opaque handles.",
    instructions: `Credential Vault (the Secure Safe compatibility surface) is Polyth's write-only credential store. Values are stored on the server (mode 0600) behind stable handles; list/read APIs and the handle manifest never return a value.

Use this skill only when the current task explicitly needs a stored credential, secret-backed authentication, a secret-backed browser fill, or a handle lookup. For unrelated tasks, do not call Credential Vault tools, inspect manifests, or discuss this capability.

Sensitive data: yes, using Credential Vault to store a credential needs a secret value supplied by the user. The package itself needs no API key or configuration to run. Treat the value as the user's, not yours: never ask for it in chat, never pass it through tool arguments, and never echo, print, log, or summarize it. Polyth redacts known values from recovery/continuity bundles, but that is a safety net, not permission to expose them.

How to discover and reuse a credential:
- When the current task needs a handle, call polyth_credential_vault_list once for the current Space/project. Do not search AGENTS.md, the root data directory, project files, or generic HTTP routes for handles.
- If the handle exists, use its handle or envRef only at the supported local composer-shell boundary (! / runShell). For Browser sign-in, use the dedicated polyth_browser_fill_from_vault tool; it keeps the value server-side.
- If no suitable handle exists, prepare the handle, label, purpose, and kind yourself and emit one secure question. Never ask the user to fill in those metadata fields.

How to ask the user for a secret:
- Emit a question request whose metadata marks it as a Credential Vault request, for example { "secureSafe": true, "handle": "STRIPE_LIVE_KEY", "label": "Stripe live key", "purpose": "Billing deploys", "kind": "env" }.
- The inline Credential Vault form is prefilled with that metadata; the user enters only the value. The server stores it by handle and replies to the question. You receive only the handle, never the value.
- If the user dismisses the request, report that the credential was not stored. Do not ask them to paste it, and do not fall back to plaintext.

How to use a stored credential:
- Reference the handle or envRef in a local composer-shell command (! / runShell). The server resolves matching POLYTH_SAFE_* refs for that one local bounded run and redacts the captured output. You never receive the value. Interactive terminals, remote shells, browser sign-in and provider runtimes do not resolve env refs; Browser sign-in uses the dedicated Vault-fill tool instead.
- Handles are global by default; project-scoped handles belong to one project. Do not copy a value between scopes.
- An entry is either the acting person's own (listed with partition "personal"; only they see, change and resolve it) or the Space's. A handle resolves to the person's own entry first, then the Space's; another member's entries are never reachable, and work no person started uses Space entries only. A saved request goes to the person's own credentials unless a Space admin picks the Space in the form.
- Do not create secrets on the user's behalf. Creating, rotating, or removing an entry is a user/UI action, except the Credential Vault request flow above.

If this skill is not relevant to the current task, ignore it silently. If Credential Vault or its UI is unavailable when it is needed, say so plainly rather than collecting a secret another way. This skill describes the mechanism; it does not grant access to any stored value.`,
  },
};
