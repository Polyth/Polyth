import { controlError, type ControlPlane } from '@polyth/control-plane';
import type { SessionService } from './sessions.ts';
import type { NormalizedExternalIdentity, ProviderPurpose } from './providers/types.ts';
import type { createProviderFramework } from './providers/framework.ts';

export type ProviderFramework = ReturnType<typeof createProviderFramework>;
export interface LinkedIdentitySummary {
  id: string;
  providerId: string;
  issuer: string;
  subject: string;
  createdAt: number;
  revision: number;
}

export function createIdentityLinks(
  control: ControlPlane,
  sessions: SessionService,
  providers: ProviderFramework,
  methodCount: (userId: string) => number,
) {
  const listFor = (userId: string): LinkedIdentitySummary[] => control.all<LinkedIdentitySummary>(
    `SELECT id,provider_config_id AS providerId,issuer,subject,created_at_ms AS createdAt,revision
       FROM login_identities WHERE user_id=? ORDER BY created_at_ms,id`, userId,
  );
  return {
    list(token: string): LinkedIdentitySummary[] {
      return listFor(sessions.require(token).userId);
    },
    begin(token: string, input: { providerId: string; browserBinding: string; callbackUrl: string; returnTo: string }) {
      const actor = sessions.require(token, true);
      return providers.begin({ ...input, purpose: 'link' as ProviderPurpose, actorUserId: actor.userId, actorSessionId: actor.id });
    },
    async complete(token: string, input: { providerId: string; state: string; browserBinding: string; code: string }) {
      const actor = sessions.require(token);
      const result = await providers.complete(
        { ...input, purpose: 'link', actorUserId: actor.userId, actorSessionId: actor.id },
        (identity: NormalizedExternalIdentity) => providers.link(actor.userId, input.providerId, identity),
      );
      return { identity: result.identity, links: listFor(actor.userId), returnTo: result.returnTo };
    },
    unlink(token: string, linkId: string, expectedRevision: number): void {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw controlError('invalid-input', 'Expected revision is required');
      control.transaction(() => {
        const actor = sessions.require(token, true);
        const row = control.get<{ revision: number }>('SELECT revision FROM login_identities WHERE id=? AND user_id=?', linkId, actor.userId);
        if (!row) throw controlError('not-found', 'Linked identity not found');
        if (row.revision !== expectedRevision) throw controlError('conflict', 'Linked identity changed; refresh before retrying');
        if (methodCount(actor.userId) <= 1) throw controlError('last-auth-method', 'At least one sign-in method must remain');
        const removed = control.run('DELETE FROM login_identities WHERE id=? AND user_id=? AND revision=?', linkId, actor.userId, expectedRevision);
        if (Number(removed.changes) !== 1) throw controlError('conflict', 'Linked identity changed; refresh before retrying');
        control.run('UPDATE principals SET auth_epoch=auth_epoch+1 WHERE id=?', actor.userId);
        control.run('DELETE FROM auth_sessions WHERE user_id=?', actor.userId);
        control.bumpEpoch(); control.audit(actor.userId, 'identity.unlinked', linkId);
      });
    },
  };
}
