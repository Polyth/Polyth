// The signed-in person's own Git profile (Spaces §14.4), shared by Settings,
// the repository identity chip and the checkout-identity reconciler.
// `usesInstallationFallback` is also the server's answer to "may this person
// write the checkout's own Git configuration" (`POST /api/git/identity` is
// instance-owner only), so every checkout-identity control asks it here.
import { useEffect, useSyncExternalStore } from "react";
import type { PersonGitProfileDto } from "@polyth/contracts/source-control";
import { sessionFetch } from "@polyth/session/web-api";

export const PERSON_GIT_PROFILE_PATH = "/api/git/profile";

export type PersonGitProfileState =
  | { status: "loading" }
  | { status: "ready"; dto: PersonGitProfileDto }
  /** The route is missing or refused (an older server, a non-person
   *  principal): the server still enforces every write. */
  | { status: "unavailable"; error: string };

const LOADING: PersonGitProfileState = { status: "loading" };
let state: PersonGitProfileState = LOADING;
let inflight: Promise<PersonGitProfileState> | null = null;
const listeners = new Set<() => void>();

const emit = (next: PersonGitProfileState): PersonGitProfileState => {
  state = next;
  for (const listener of [...listeners]) listener();
  return next;
};

export const getPersonGitProfileState = (): PersonGitProfileState => state;

export function subscribePersonGitProfile(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Reads once and shares the answer; `force` re-reads (Settings on open). */
export function loadPersonGitProfile(force = false): Promise<PersonGitProfileState> {
  if (inflight) return inflight;
  if (!force && state.status !== "loading") return Promise.resolve(state);
  inflight = sessionFetch<PersonGitProfileDto>(PERSON_GIT_PROFILE_PATH)
    .then((dto) => emit({ status: "ready", dto }))
    .catch((cause: unknown) => emit({ status: "unavailable", error: cause instanceof Error ? cause.message : String(cause) }))
    .finally(() => { inflight = null; });
  return inflight;
}

export function setPersonGitProfile(dto: PersonGitProfileDto): void {
  emit({ status: "ready", dto });
}

/** Test seam: forget the cached answer. */
export function resetPersonGitProfile(): void {
  inflight = null;
  emit(LOADING);
}

/** Whether checkout-identity controls apply to this person. Without a profile
 *  route the legacy controls stay (the server still refuses non-owners). */
export function mayWriteCheckoutIdentity(current: PersonGitProfileState = state): boolean {
  if (current.status === "ready") return current.dto.usesInstallationFallback;
  return current.status === "unavailable";
}

export function usePersonGitProfile(options: { refresh?: boolean } = {}): PersonGitProfileState {
  const current = useSyncExternalStore(subscribePersonGitProfile, getPersonGitProfileState, getPersonGitProfileState);
  useEffect(() => {
    void loadPersonGitProfile(options.refresh === true);
  }, [options.refresh]);
  return current;
}
