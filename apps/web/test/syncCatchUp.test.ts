import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATCH_UP_ERROR_GRACE_MS,
  CATCH_UP_INDICATOR_DELAY_MS,
  catchUpView,
  isHoldableNetworkError,
} from "../src/syncCatchUp.ts";
import { tr } from "../src/i18n/index.ts";

const stale = { session: false, sessions: false };
const fresh = { session: true, sessions: true };

test("a quick catch-up shows nothing; a slow one says updating, or reconnecting while the socket is down", () => {
  assert.deepEqual(catchUpView({ freshness: fresh, status: "connected", staleSince: null, now: 0 }),
    { fresh: true, indicator: "hidden", holdNetworkErrors: false });
  const early = catchUpView({ freshness: stale, status: "connected", staleSince: 1_000, now: 1_000 + CATCH_UP_INDICATOR_DELAY_MS - 1 });
  assert.equal(early.indicator, "hidden");
  assert.equal(early.holdNetworkErrors, true);
  assert.equal(catchUpView({ freshness: stale, status: "connected", staleSince: 0, now: CATCH_UP_INDICATOR_DELAY_MS }).indicator, "updating");
  assert.equal(catchUpView({ freshness: stale, status: "reconnecting", staleSince: 0, now: CATCH_UP_INDICATOR_DELAY_MS }).indicator, "reconnecting");
  assert.equal(catchUpView({ freshness: { session: true, sessions: false }, status: "connected", staleSince: 0, now: 5_000 }).indicator, "updating",
    "the list still catching up is still not current");
});

test("transport errors are held only while the system can still heal, and never in the background's favour", () => {
  assert.equal(catchUpView({ freshness: stale, status: "reconnecting", staleSince: 0, now: CATCH_UP_ERROR_GRACE_MS - 1 }).holdNetworkErrors, true);
  assert.equal(catchUpView({ freshness: stale, status: "reconnecting", staleSince: 0, now: CATCH_UP_ERROR_GRACE_MS }).holdNetworkErrors, false);
  const background = catchUpView({ freshness: stale, status: "suspended", staleSince: null, now: 99_999 });
  assert.equal(background.indicator, "hidden");
  assert.equal(background.holdNetworkErrors, true);
});

test("only connection-loss reads are holdable; an unknown write outcome always surfaces", () => {
  assert.equal(isHoldableNetworkError(`Open session: ${tr("settings.polythConnectionLost")}`), true);
  assert.equal(isHoldableNetworkError("Load failed"), true);
  assert.equal(isHoldableNetworkError(`Send message: ${tr("settings.mutationOutcomeUnknown")}`), false);
  // Its copy names the dropped connection, yet it reports an unknown write.
  assert.equal(isHoldableNetworkError(`${tr("composer.newChatNotConfirmed")}: ${tr("composer.newChatOutcomeUnknown")}`), false);
  assert.equal(isHoldableNetworkError("Rename project: name already exists"), false);
});
