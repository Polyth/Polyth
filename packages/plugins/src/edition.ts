// The workstation edition never installs packages from a source and never
// checks one for a new release: the app itself may not download or run an
// installer (docs/security/workstation-edition.md). The edition is read from
// the environment on every call, never at module load, so a process can be
// tested in either edition.
import { EDITION_UNAVAILABLE_CODE, isWorkstationEdition } from "@polyth/contracts/edition";

/** True when this process runs as the workstation edition. */
export const workstationEdition = (): boolean => isWorkstationEdition(process.env);

/**
 * The error a package install, update or source check raises in the
 * workstation edition. `code` is the edition's code so a client can explain
 * it; `status` is 403 because the HTTP layer maps an unknown code by status
 * and this is a refused request, not a server bug.
 */
export const editionUnavailable = (what: string): Error =>
  Object.assign(new Error(`${what} is not available in the workstation edition`), {
    code: EDITION_UNAVAILABLE_CODE,
    status: 403,
  });
