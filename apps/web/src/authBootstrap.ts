// Browser-safe, explicit authorization. `required: false` is not permission.
import type { AuthStatusDto } from '@polyth/session/web-api';

export type BrowserInstallationState = 'uninitialized' | 'claimed' | 'configuring' | 'ready' | 'recovery';
export interface BrowserAuthStatus extends AuthStatusDto {
  state?: BrowserInstallationState;
  methods?: string[];
  csrfToken?: string;
  bootstrapMode?: 'setup';
}

export function validateAuthStatus(value: unknown): BrowserAuthStatus {
  if (!value || typeof value !== 'object') throw new Error('Invalid authentication status');
  const status = value as BrowserAuthStatus & { scope?: unknown };
  if (typeof status.required !== 'boolean' || typeof status.authorized !== 'boolean' || typeof status.scope !== 'string'
    || !['anonymous', 'local-user', 'ui-session', 'paired-device', 'internal-service'].includes(status.scope)
    || (status.authorized && !['local-user', 'ui-session', 'paired-device'].includes(status.scope))) {
    throw new Error('Invalid authentication status');
  }
  if (status.state !== undefined && !['uninitialized', 'claimed', 'configuring', 'ready', 'recovery'].includes(status.state)) {
    throw new Error('Invalid installation state');
  }
  if (status.csrfToken !== undefined && !/^[a-f0-9]{64}$/.test(status.csrfToken)) {
    throw new Error('Invalid authentication nonce');
  }
  if (status.bootstrapMode !== undefined && status.bootstrapMode !== 'setup') {
    throw new Error('Invalid bootstrap mode');
  }
  return status;
}

export function authBootstrapPhase(status: unknown): 'setup' | 'locked' | 'ready' | 'unavailable' {
  const value = validateAuthStatus(status);
  if (value.state === 'recovery') return 'unavailable';
  if (value.bootstrapMode === 'setup' || (value.state && value.state !== 'ready')) return 'setup';
  return value.authorized ? 'ready' : 'locked';
}
