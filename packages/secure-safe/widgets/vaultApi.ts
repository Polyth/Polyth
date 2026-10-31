// Personal-partition routes of this package. Space entries keep using the
// shared session web API (`api.*SecureSafe`).
import type { SecureSafeCreateInput, SecureSafeEntryDto, SecureSafePartition, SecureSafePatchInput } from "@polyth/contracts";
import { createApiTransport } from "@polyth/web-sdk";

export interface VaultAccess {
  /** Space admin: may change Space credentials and save requests to the Space. */
  canManageSpace: boolean;
  /** A signed-in person with their own partition. */
  personal: boolean;
}

const transport = createApiTransport();

export const vaultApi = {
  access: () => transport.get<VaultAccess>("/api/secure-safe/access"),
  listPersonal: () => transport.get<SecureSafeEntryDto[]>("/api/secure-safe/personal"),
  savePersonal: (input: SecureSafeCreateInput) =>
    transport.post<SecureSafeEntryDto>("/api/secure-safe/personal", input),
  updatePersonal: (id: string, input: SecureSafePatchInput) =>
    transport.patch<SecureSafeEntryDto>(`/api/secure-safe/personal/${encodeURIComponent(id)}`, input),
  deletePersonal: (id: string) =>
    transport.delete<{ ok: boolean }>(`/api/secure-safe/personal/${encodeURIComponent(id)}`),
  /** Answer a chat's credential request into a chosen partition. The value
   *  goes only into this write request; the server decides whether the
   *  choice is allowed. */
  saveRequested: (sessionId: string, requestId: string, value: string, partition: SecureSafePartition) =>
    transport.post<void>(
      `/api/sessions/${encodeURIComponent(sessionId)}/secrets/${encodeURIComponent(requestId)}`,
      { action: "save", value, partition },
    ),
};
