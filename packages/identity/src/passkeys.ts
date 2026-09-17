import { createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { controlError, digest, type ControlPlane } from '@polyth/control-plane';
import type { SessionService } from './sessions.ts';
import { opaqueId } from './validation.ts';
import { base64url, decodeBase64url, decodeCbor, equalBytes, parseAuthenticatorData, parseClientData, rpIdHash, coseToSpki } from './webauthnCodec.ts';

export interface WebAuthnConfig {
  origin: string;
  rpId?: string;
  rpName?: string;
  challengeTtlMs?: number;
}
export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revision: number;
}
interface ChallengeRow {
  id: string;
  purpose: 'registration' | 'authentication';
  user_id: string | null;
  session_id: string | null;
  rp_id: string;
  origin: string;
  expires_at_ms: number;
  consumed_at_ms: number | null;
}
interface CredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key_spki_pem: string;
  algorithm: -257 | -8 | -7;
  rp_id: string;
  sign_count: number;
  revision: number;
  status: string;
  auth_epoch: number;
}
const challengeHash = (challenge: string): string => digest(`webauthn:${challenge}`);
const text = (value: unknown, maximum: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\x00-\x1f\x7f]/.test(value)) {
    throw controlError('invalid-input', 'Passkey name is invalid');
  }
  return value.trim();
};
const clientChallenge = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) throw controlError('invalid-credentials', 'Passkey response is invalid');
  return value;
};
const authDataFromAttestation = (encoded: unknown): Buffer => {
  const attestation = decodeCbor(decodeBase64url(encoded, 64_000));
  if (!(attestation instanceof Map)) throw controlError('invalid-credentials', 'Passkey response is invalid');
  const authData = attestation.get('authData');
  if (!Buffer.isBuffer(authData)) throw controlError('invalid-credentials', 'Passkey response is invalid');
  return authData;
};

export function createPasskeys(control: ControlPlane, sessions: SessionService, now: () => number, config?: WebAuthnConfig) {
  const parsedOrigin = config ? new URL(config.origin) : null;
  const origin = parsedOrigin?.origin ?? null;
  const rpId = config?.rpId ?? parsedOrigin?.hostname ?? null;
  const rpName = config?.rpName?.trim() || 'Polyth';
  const ttl = config?.challengeTtlMs ?? 5 * 60_000;
  if (config) {
    if (parsedOrigin!.origin !== config.origin || parsedOrigin!.username || parsedOrigin!.password || parsedOrigin!.pathname !== '/'
      || parsedOrigin!.search || parsedOrigin!.hash || !rpId || !Number.isSafeInteger(ttl) || ttl < 30_000 || ttl > 15 * 60_000) {
      throw controlError('invalid-input', 'Invalid WebAuthn configuration');
    }
    const host = parsedOrigin!.hostname.toLowerCase();
    const validRp = host === rpId.toLowerCase() || host.endsWith(`.${rpId.toLowerCase()}`);
    const localHttp = parsedOrigin!.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
    if (!validRp || (parsedOrigin!.protocol !== 'https:' && !localHttp)) throw controlError('invalid-input', 'Invalid WebAuthn configuration');
  }
  const requireConfig = (): { origin: string; rpId: string } => {
    if (!origin || !rpId) throw controlError('unavailable', 'Passkeys are not configured for this installation');
    return { origin, rpId };
  };
  const pruneChallenges = (): void => {
    const cutoff = now();
    control.run('DELETE FROM webauthn_challenges WHERE expires_at_ms<=? OR consumed_at_ms IS NOT NULL', cutoff);
  };
  const newChallenge = (purpose: ChallengeRow['purpose'], userId: string | null, sessionId: string | null): string => {
    const cfg = requireConfig(), challenge = randomBytes(32).toString('base64url'), time = now();
    control.transaction(() => {
      pruneChallenges();
      const outstanding = control.get<{ n: number }>('SELECT count(*) AS n FROM webauthn_challenges')?.n ?? 0;
      if (outstanding >= 1024) throw controlError('rate-limited', 'Too many passkey attempts');
      control.run('INSERT INTO webauthn_challenges(id,challenge_hash,purpose,user_id,session_id,rp_id,origin,created_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?,?,?)',
        opaqueId('wch'), challengeHash(challenge), purpose, userId, sessionId, cfg.rpId, cfg.origin, time, time + ttl);
    });
    return challenge;
  };
  const challengeFor = (challenge: string, purpose: ChallengeRow['purpose']): ChallengeRow => {
    const cfg = requireConfig(), row = control.get<ChallengeRow>(
      'SELECT id,purpose,user_id,session_id,rp_id,origin,expires_at_ms,consumed_at_ms FROM webauthn_challenges WHERE challenge_hash=? AND purpose=?',
      challengeHash(clientChallenge(challenge)), purpose,
    );
    if (!row || row.consumed_at_ms !== null || row.expires_at_ms <= now() || row.rp_id !== cfg.rpId || row.origin !== cfg.origin) {
      throw controlError('invalid-credentials', 'Passkey response is invalid or expired');
    }
    return row;
  };
  const credential = (credentialId: string): CredentialRow | undefined => control.get<CredentialRow>(
    `SELECT c.id,c.user_id,c.credential_id,c.public_key_spki_pem,c.algorithm,c.rp_id,c.sign_count,c.revision,p.status,p.auth_epoch
     FROM passkey_credentials c JOIN principals p ON p.id=c.user_id WHERE c.credential_id=?`, credentialId,
  );
  const usable = (row: CredentialRow | undefined): row is CredentialRow => !!row && row.status === 'active'
    && control.installation().state === 'ready' && row.rp_id === rpId;
  const verifyAssertion = (row: CredentialRow, authData: Buffer, clientDataRaw: Buffer, signature: Buffer): number => {
    const parsed = parseAuthenticatorData(authData, false);
    if (!equalBytes(parsed.rpHash, rpIdHash(requireConfig().rpId))) throw controlError('invalid-credentials', 'Passkey response is invalid');
    const signed = Buffer.concat([authData, Buffer.from(digest(clientDataRaw), 'hex')]);
    let valid = false;
    try {
      const key = createPublicKey(row.public_key_spki_pem);
      valid = row.algorithm === -8 ? verifySignature(null, signed, key, signature) : verifySignature('sha256', signed, key, signature);
    } catch { valid = false; }
    if (!valid) throw controlError('invalid-credentials', 'Passkey response is invalid');
    if (row.sign_count !== 0 && parsed.signCount !== 0 && parsed.signCount <= row.sign_count) {
      throw controlError('invalid-credentials', 'Passkey counter did not advance');
    }
    return parsed.signCount;
  };
  const summaries = (userId: string): PasskeySummary[] => control.all<PasskeySummary>(
    'SELECT id,name,created_at_ms AS createdAt,last_used_at_ms AS lastUsedAt,revision FROM passkey_credentials WHERE user_id=? ORDER BY created_at_ms,id', userId,
  );
  const methodCount = (userId: string): number => {
    const password = control.get<{ n: number }>('SELECT count(*) AS n FROM password_credentials WHERE user_id=?', userId)?.n ?? 0;
    const passkeys = control.get<{ n: number }>('SELECT count(*) AS n FROM passkey_credentials WHERE user_id=?', userId)?.n ?? 0;
    const providers = control.get<{ n: number }>(
      `SELECT count(*) AS n FROM login_identities l JOIN identity_providers p
       ON p.id=l.provider_config_id AND p.issuer=l.issuer WHERE l.user_id=? AND p.enabled=1`, userId,
    )?.n ?? 0;
    return password + passkeys + providers;
  };
  return {
    available: () => !!origin,
    list(token: string): PasskeySummary[] { return summaries(sessions.require(token).userId); },
    beginRegistration(token: string, name: string) {
      const actor = sessions.require(token, true), cfg = requireConfig(), label = text(name, 80);
      const login = control.get<{ login_name: string }>('SELECT login_name FROM password_credentials WHERE user_id=?', actor.userId)?.login_name ?? actor.userId;
      const challenge = newChallenge('registration', actor.userId, actor.id);
      const excludeCredentials = control.all<{ credential_id: string }>('SELECT credential_id FROM passkey_credentials WHERE user_id=?', actor.userId)
        .map(row => ({ type: 'public-key' as const, id: row.credential_id }));
      return {
        challenge, rp: { id: cfg.rpId, name: rpName },
        user: { id: Buffer.from(actor.userId, 'utf8').toString('base64url'), name: login, displayName: actor.displayName },
        pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }, { type: 'public-key' as const, alg: -8 }, { type: 'public-key' as const, alg: -257 }],
        timeout: ttl, attestation: 'none' as const,
        authenticatorSelection: { residentKey: 'required' as const, userVerification: 'required' as const },
        excludeCredentials, label,
      };
    },
    completeRegistration(token: string, input: { name: string; clientDataJSON: string; attestationObject: string; credentialId?: string }) {
      const actor = sessions.require(token, true), cfg = requireConfig(), label = text(input.name, 80);
      const client = parseClientData(input.clientDataJSON, 'webauthn.create', cfg.origin);
      const challenge = challengeFor(client.data.challenge, 'registration');
      if (challenge.user_id !== actor.userId || challenge.session_id !== actor.id) throw controlError('invalid-credentials', 'Passkey response is invalid');
      const authData = parseAuthenticatorData(authDataFromAttestation(input.attestationObject), true);
      if (!equalBytes(authData.rpHash, rpIdHash(cfg.rpId)) || !authData.credentialId || !authData.coseKey) throw controlError('invalid-credentials', 'Passkey response is invalid');
      const credentialId = base64url(authData.credentialId);
      if (input.credentialId !== undefined && input.credentialId !== credentialId) throw controlError('invalid-credentials', 'Passkey response is invalid');
      const key = coseToSpki(authData.coseKey);
      return control.transaction(() => {
        const current = sessions.require(token, true);
        if (current.id !== actor.id || current.userId !== actor.userId) throw controlError('invalid-credentials', 'Passkey response is invalid');
        const fresh = challengeFor(client.data.challenge, 'registration');
        if (fresh.id !== challenge.id || fresh.session_id !== actor.id || fresh.user_id !== actor.userId) throw controlError('invalid-credentials', 'Passkey response is invalid');
        const consumed = control.run('UPDATE webauthn_challenges SET consumed_at_ms=? WHERE id=? AND consumed_at_ms IS NULL AND expires_at_ms>?', now(), fresh.id, now());
        if (Number(consumed.changes) !== 1) throw controlError('invalid-credentials', 'Passkey response is invalid or expired');
        if (credential(credentialId)) throw controlError('conflict', 'Passkey is already registered');
        const id = opaqueId('pky'), time = now();
        control.run('INSERT INTO passkey_credentials(id,user_id,credential_id,public_key_spki_pem,algorithm,rp_id,sign_count,name,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)',
          id, actor.userId, credentialId, key.pem, key.algorithm, cfg.rpId, authData.signCount, label, time);
        control.bumpEpoch(); control.audit(actor.userId, 'auth.passkey-added', id);
        return summaries(actor.userId).find(item => item.id === id)!;
      });
    },
    beginAuthentication() {
      const cfg = requireConfig(), challenge = newChallenge('authentication', null, null);
      return { challenge, rpId: cfg.rpId, timeout: ttl, userVerification: 'required' as const };
    },
    completeAuthentication(input: { credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null; label?: string }) {
      const cfg = requireConfig(), client = parseClientData(input.clientDataJSON, 'webauthn.get', cfg.origin);
      const challenge = challengeFor(client.data.challenge, 'authentication');
      const credentialId = base64url(decodeBase64url(input.credentialId));
      const observed = credential(credentialId);
      if (!usable(observed)) throw controlError('invalid-credentials', 'Passkey response is invalid');
      if (input.userHandle) {
        const handle = decodeBase64url(input.userHandle);
        if (!equalBytes(handle, Buffer.from(observed.user_id, 'utf8'))) throw controlError('invalid-credentials', 'Passkey response is invalid');
      }
      const authData = decodeBase64url(input.authenticatorData), signature = decodeBase64url(input.signature);
      const nextCount = verifyAssertion(observed, authData, client.raw, signature);
      return control.transaction(() => {
        const freshChallenge = challengeFor(client.data.challenge, 'authentication'), current = credential(credentialId);
        if (freshChallenge.id !== challenge.id || !usable(current) || current.id !== observed.id || current.revision !== observed.revision
          || current.auth_epoch !== observed.auth_epoch) throw controlError('invalid-credentials', 'Passkey response is invalid');
        // Reverify after waiting for the writer lock so a changed key/counter cannot
        // race an already-computed signature result into a session.
        verifyAssertion(current, authData, client.raw, signature);
        const consumed = control.run('UPDATE webauthn_challenges SET consumed_at_ms=? WHERE id=? AND consumed_at_ms IS NULL AND expires_at_ms>?', now(), freshChallenge.id, now());
        if (Number(consumed.changes) !== 1) throw controlError('invalid-credentials', 'Passkey response is invalid or expired');
        control.run('UPDATE passkey_credentials SET sign_count=?,last_used_at_ms=?,revision=revision+1 WHERE id=? AND revision=?',
          nextCount === 0 ? current.sign_count : nextCount, now(), current.id, current.revision);
        control.audit(current.user_id, 'auth.passkey-used', current.id);
        return sessions.issue(current.user_id, input.label ?? 'Passkey');
      });
    },
    remove(token: string, id: string, expectedRevision: number) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw controlError('invalid-input', 'Expected revision is required');
      control.transaction(() => {
        const actor = sessions.require(token, true);
        const row = control.get<{ revision: number }>('SELECT revision FROM passkey_credentials WHERE id=? AND user_id=?', id, actor.userId);
        if (!row) throw controlError('not-found', 'Passkey not found');
        if (row.revision !== expectedRevision) throw controlError('conflict', 'Passkey changed; refresh before retrying');
        if (methodCount(actor.userId) <= 1) throw controlError('last-auth-method', 'At least one sign-in method must remain');
        control.run('DELETE FROM passkey_credentials WHERE id=? AND user_id=? AND revision=?', id, actor.userId, expectedRevision);
        control.run('UPDATE principals SET auth_epoch=auth_epoch+1 WHERE id=?', actor.userId);
        control.run('DELETE FROM auth_sessions WHERE user_id=? AND id<>?', actor.userId, actor.id);
        control.bumpEpoch(); control.audit(actor.userId, 'auth.passkey-removed', id);
      });
    },
    methodCount,
  };
}
export type PasskeyService = ReturnType<typeof createPasskeys>;
