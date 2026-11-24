// Client of the "move a chat between checkouts" routes. Goes through the same
// session fetch as the other Git widgets, so a typed refusal keeps its
// `code`/`refusal` and `errorCodeOf` / `errorRefusalOf` read it.
import { sessionFetch } from "@polyth/session/web-api";
import type {
  SessionCheckoutInput, SessionCheckoutPreview, SessionCheckoutPreviewInput, SessionCheckoutResult,
} from "../src/sessionCheckoutMove.ts";

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const gitSessionCheckoutPreview = (input: SessionCheckoutPreviewInput): Promise<SessionCheckoutPreview> =>
  sessionFetch<SessionCheckoutPreview>("/api/git/session-checkout/preview", post(input));

export const gitSessionCheckout = (input: SessionCheckoutInput): Promise<SessionCheckoutResult> =>
  sessionFetch<SessionCheckoutResult>("/api/git/session-checkout", post(input));
