# Checkout updates (`@polyth/checkout-update`)

Lets a Polyth server that runs from a git source checkout update itself through
Settings → About → **Update automatically**, like a packaged npm or Homebrew
server. The host decides when (no chat working) and restarts through its
service; this package only contributes the driver that says how, through the
host's `SERVER_SELF_UPDATE` service (`@polyth/plugins`). Remove the folder and
the row says the server cannot update itself; nothing else changes.

It contributes the driver only when the server's own script
(`process.argv[1]`) lives in the checkout this package was loaded from. A
packaged build has no `.git` beside `packages/`, so there it contributes
nothing and the packaged server's own driver applies.

What the driver does, and what it refuses, is in
[running Polyth → source checkouts](../../docs/operations/running.md#source-checkouts-checkout-update-package):
fast-forward only, a clean tracked tree only, in-place `npm install --no-save`,
`npm run build`, a Link host rebuild when the Rust sources changed, a module
check of the new server, and a reset to the previous commit when any step
fails.

Keep the deployment checkout a mirror of the remote. Make changes in another
clone (a Polyth project) and push them with your own account; the deployment
follows the branch.

Tests: `npm test -w @polyth/checkout-update` (real temporary git repositories;
the build steps are replaced by fixtures).
