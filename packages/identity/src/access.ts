import { controlError, type ControlPlane } from '@polyth/control-plane';

/**
 * How people reach this installation. `accounts`: the owner signs in with a
 * credential. `local`: a Polyth Desktop owner without any credential, whose
 * only owner session comes from the Desktop main process. Never inferred from
 * a request; a missing column value reads as `accounts`.
 */
export type AccessMode = 'accounts' | 'local';

export const accessMode = (control: ControlPlane): AccessMode =>
  control.get<{ access_mode: string }>('SELECT access_mode FROM installation WHERE singleton=1')?.access_mode === 'local'
    ? 'local'
    : 'accounts';

/** Anything that admits another person or another way in (accounts, passkeys,
 *  external sign-in) first needs an owner credential. */
export function requireOwnerCredential(control: ControlPlane): void {
  if (accessMode(control) === 'local') {
    throw controlError('owner-credential-required', 'Protect the owner account with a password first');
  }
}
