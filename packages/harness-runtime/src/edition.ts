// The workstation edition never downloads a harness installer or a Node
// runtime and never asks npm for harness releases; the person installs their
// CLIs themselves (docs/security/workstation-edition.md). The edition is read
// from the environment on every call, never at module load.
import { EDITION_UNAVAILABLE_CODE, isWorkstationEdition } from "@polyth/contracts/edition";

/** True when this process runs as the workstation edition. */
export const workstationEdition = (): boolean => isWorkstationEdition(process.env);

/**
 * The error an install, reinstall or self-update raises in the workstation
 * edition. `code` is the edition's code so the client can explain it; `status`
 * is 403 because the HTTP layer maps an unknown code by status and this is a
 * refused request, not a server bug.
 */
export const editionUnavailable = (what: string): Error =>
  Object.assign(new Error(`${what} is not available in the workstation edition`), {
    code: EDITION_UNAVAILABLE_CODE,
    status: 403,
  });
