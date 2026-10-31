// The btw wire contract, shared by the route and the browser card. Browser
// safe: no Node or session-store imports.

/** Longest side question accepted, in characters. */
export const BTW_QUESTION_MAX = 4_000;
/** Earlier side questions of the same card sent along as context. */
export const BTW_THREAD_MAX = 6;
/** Longest earlier answer kept in that thread, in characters. */
export const BTW_THREAD_ANSWER_MAX = 4_000;

export interface BtwThreadEntry {
  question: string;
  answer: string;
}

export interface BtwRequest {
  question: string;
  thread?: BtwThreadEntry[];
}

export interface BtwResponse {
  answer: string;
}

export const btwPath = (sessionId: string): string => `/api/sessions/${encodeURIComponent(sessionId)}/btw`;
