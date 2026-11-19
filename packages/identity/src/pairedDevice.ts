import { controlError, type ControlPlane } from '@polyth/control-plane';
import type { SessionService } from './sessions.ts';
import type { createCredentials } from './credentials.ts';

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
/** Label prefix of the server-side session a paired device administers with.
 *  It is not a browser sign-in, so Settings → Security leaves these rows out. */
export const PAIRED_SESSION_LABEL = 'Polyth Link device';
/** One session row per device, so a restart or a new confirmation replaces it
 *  instead of piling more rows. */
const sessionLabel = (deviceId: string): string => `${PAIRED_SESSION_LABEL} ${deviceId}`.slice(0, 120);

/**
 * Account administration from a full-access paired device (Polyth Link).
 *
 * The device grant authenticates the request and no cookie is involved, so
 * CSRF and same-origin cannot apply. Instead the authority keeps one identity
 * session per device **in this process only**: administration runs through the
 * same elevated services as a browser, and the session token is never returned
 * to the client. A device reads people with a plain session; changing them
 * needs `confirm` — the person's own password within the last five minutes,
 * exactly like a browser's recent sign-in. A restart forgets elevations.
 */
export type PairedDeviceService = ReturnType<typeof createPairedDevice>;
export function createPairedDevice(
  control: ControlPlane,
  sessions: SessionService,
  credentials: ReturnType<typeof createCredentials>,
  now: () => number,
) {
  /** `${userId}\0${deviceId}` → server-side session token. Never leaves here. */
  const held = new Map<string, string>();
  const keyOf = (userId: string, deviceId: string): string => {
    if (!DEVICE_ID.test(deviceId)) throw controlError('invalid-input', 'Invalid device identifier');
    return `${userId}\u0000${deviceId}`;
  };
  const session = (userId: string, deviceId: string): string => {
    const key = keyOf(userId, deviceId);
    const existing = held.get(key);
    if (existing) {
      const live = sessions.resolve(existing);
      if (live && live.userId === userId) return existing;
      held.delete(key);
    }
    const token = control.transaction(() => {
      control.run('DELETE FROM auth_sessions WHERE user_id=? AND label=?', userId, sessionLabel(deviceId));
      const issued = sessions.issue(userId, sessionLabel(deviceId));
      // Only `confirm` proves a person is present. A device that has not
      // confirmed may read its own installation's people, never change them.
      control.run('UPDATE auth_sessions SET elevated_at_ms=NULL WHERE id=?', issued.session.id);
      control.audit(userId, 'auth.paired-device-session', deviceId);
      return issued.token;
    });
    held.set(key, token);
    return token;
  };
  return {
    /** The device's own session, created on first use. Used for reads. */
    session,
    /** Verify the person's password and elevate that session for five minutes. */
    async confirm(input: { userId: string; deviceId: string; password: string; address?: string }): Promise<void> {
      await credentials.confirmDevicePassword(input);
      const token = session(input.userId, input.deviceId);
      control.transaction(() => {
        const current = sessions.require(token);
        control.run('UPDATE auth_sessions SET elevated_at_ms=?,revision=revision+1 WHERE id=?', now(), current.id);
        control.audit(current.userId, 'auth.paired-device-confirmed', input.deviceId);
      });
    },
  };
}
