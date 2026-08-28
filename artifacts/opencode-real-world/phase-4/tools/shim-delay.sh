#!/usr/bin/env bash
# OC-REAL-048 shim: records its own PID (the exact child PID Polyth spawned),
# then delays before exec'ing the real opencode binary. The harness kills the
# exact recorded PID during the delay window, i.e. after spawn but before the
# listen line can ever be printed. A `nodelay` flag file disables the window so
# the recovery attempt proceeds like the real binary.
set -u
echo "$$" >> "${OC_SHIM_DIR}/wrapper-pids.txt"
if [ ! -f "${OC_SHIM_DIR}/nodelay" ]; then
  sleep "${OC_SHIM_DELAY_S:-8}"
fi
exec "${OC_REAL_BIN:-/home/ubuntu/.local/bin/opencode}" "$@"
