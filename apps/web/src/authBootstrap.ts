// Browser-safe, explicit authorization. `required: false` is not permission.
import type { AuthStatusDto } from '@polyth/session/web-api';
export function validateAuthStatus(value: unknown): AuthStatusDto {
  if (!value || typeof value !== 'object') throw new Error('Invalid authentication status');
  const status = value as AuthStatusDto & { scope?: unknown };
  if (typeof status.required !== 'boolean' || typeof status.authorized !== 'boolean' || typeof status.scope !== 'string'
    || !['anonymous', 'local-user', 'ui-session', 'paired-device', 'internal-service'].includes(status.scope)
    || (status.authorized && !['local-user', 'ui-session', 'paired-device'].includes(status.scope))) {
    throw new Error('Invalid authentication status');
  }
  return status;
}
export function authBootstrapPhase(status: unknown): 'locked' | 'ready' {
  return validateAuthStatus(status).authorized ? 'ready' : 'locked';
}
