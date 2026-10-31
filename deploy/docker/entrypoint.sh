#!/bin/sh
# Polyth container entrypoint. Runs under tini as PID 1 so agent runtimes and
# their children are reaped. See docs/operations/docker.md.
set -eu

cd /opt/polyth
run() { exec node --experimental-strip-types "$@"; }

case "${1:-serve}" in
  serve)
    shift || true
    run packages/server/src/index.ts "$@"
    ;;
  setup-claim)
    shift
    run scripts/setup-claim.ts "$@"
    ;;
  break-glass)
    shift
    run scripts/break-glass-password.ts "$@"
    ;;
  migrate-legacy)
    shift
    run scripts/legacy-migration.ts "$@"
    ;;
  help|--help|-h)
    cat <<'EOF'
Usage: polyth [serve|setup-claim|break-glass|migrate-legacy|<command>...]

  serve           Start the Polyth server (default).
  setup-claim     Print a short-lived first-run setup claim. Run it while the
                  server is stopped: the server holds the data-directory lease.
  break-glass     Offline owner password recovery (see --help).
  migrate-legacy  Legacy data migration (see --help).
  <command>       Any other command runs as-is, e.g. `opencode auth login`.
EOF
    ;;
  *)
    exec "$@"
    ;;
esac
