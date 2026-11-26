package com.polyth.mobile;

/**
 * How many WebView renderer deaths the app recovers from before it stops
 * trying. A renderer that dies again straight after a recovery (a page that
 * crashes it on every load) must not turn into an endless recreate loop, so at
 * most {@link #MAX_RECOVERIES} recoveries are allowed inside any sliding
 * {@link #WINDOW_MS} window. Pure logic with an injected clock, so it is unit
 * tested without a WebView; the one process-wide instance lives in
 * {@link MainActivity} so the count survives the activity being recreated.
 */
final class RenderRecoveryBudget {
    static final int MAX_RECOVERIES = 2;
    static final long WINDOW_MS = 60_000L;

    private final int maxRecoveries;
    private final long windowMs;
    private final long[] recent;
    private int count;

    RenderRecoveryBudget() {
        this(MAX_RECOVERIES, WINDOW_MS);
    }

    RenderRecoveryBudget(int maxRecoveries, long windowMs) {
        if (maxRecoveries < 1) throw new IllegalArgumentException("maxRecoveries must be positive");
        if (windowMs < 1) throw new IllegalArgumentException("windowMs must be positive");
        this.maxRecoveries = maxRecoveries;
        this.windowMs = windowMs;
        this.recent = new long[maxRecoveries];
    }

    /**
     * Record a renderer death at {@code nowMs} (a monotonic clock) and say
     * whether the app should recover from it. A refused death is not recorded,
     * so the budget frees up again once the window has passed.
     */
    synchronized boolean tryRecover(long nowMs) {
        int kept = 0;
        for (int i = 0; i < count; i++) {
            long at = recent[i];
            // A clock that went backwards cannot prove the old entry is stale.
            if (nowMs - at < windowMs || nowMs < at) recent[kept++] = at;
        }
        count = kept;
        if (count >= maxRecoveries) return false;
        recent[count++] = nowMs;
        return true;
    }
}
