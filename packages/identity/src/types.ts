// Browser-safe DTOs. Never export credentials, cookie tokens or SQL rows here.
export interface IdentityUser {
  id: string;
  displayName: string;
  managed: boolean;
  status: 'active' | 'suspended' | 'offboarding' | 'disabled';
  revision: number;
}
export interface IdentitySession {
  id: string; userId: string; displayName: string; userRevision: number;
  createdAt: number; expiresAt: number; elevatedAt: number | null;
}
export interface SetupStatus {
  state: 'uninitialized' | 'claimed' | 'configuring' | 'ready' | 'recovery';
  methods: readonly ['password'];
}
export interface SessionSummary {
  id: string; label: string; current: boolean; createdAt: number;
  lastSeenAt: number; expiresAt: number; revision: number;
}
