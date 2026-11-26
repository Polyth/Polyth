package com.polyth.mobile;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public class MainActivity extends BridgeActivity {
    private static final AtomicReference<String> PENDING_URL = new AtomicReference<>();
    private static final String TAG = "PolythMainActivity";
    /** Process-wide, so a recovery loop is still counted across recreates. */
    private static final RenderRecoveryBudget RENDER_RECOVERY = new RenderRecoveryBudget();
    /** The next onCreate is a renderer recovery, not a launch: the activity's
     * old launch intent (deep link, notification tap) must not be replayed. */
    private static final AtomicBoolean RECREATING_AFTER_RENDER_GONE = new AtomicBoolean(false);

    /** This activity's WebView already died and its replacement is scheduled. */
    private boolean renderRecoveryScheduled;

    private static void rememberPendingUrl(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri data = intent.getData();
        if (data != null) PENDING_URL.set(data.toString());
    }

    static String consumePendingUrl() {
        return PENDING_URL.getAndSet(null);
    }

    /** A locally-generated notification tap never carries a URL. The page of
     * the tap's own server, when it is the one on screen, claims the validated
     * native pending id and opens the chat in place. Every other tap goes to
     * the bundled hub, which consumes the id and reconnects the saved mapping. */
    private void routeNativePushOpen(Intent intent) {
        if (intent == null || getBridge() == null || !PolythPushPlugin.recordTap(getApplicationContext(), intent)) return;
        Runnable returnToHub = () -> {
            if (isDestroyed() || getBridge() == null) return;
            getBridge().getWebView().loadUrl("https://localhost");
        };
        if (!PolythPushPlugin.offerPendingOpenToLivePage(getApplicationContext(), getBridge(), returnToHub)) returnToHub.run();
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        boolean renderRecovery = RECREATING_AFTER_RENDER_GONE.getAndSet(false);
        if (!renderRecovery) rememberPendingUrl(getIntent());
        registerPlugin(PolythLinkPlugin.class);
        registerPlugin(PolythDiscoveryPlugin.class);
        registerPlugin(PolythNavigationPlugin.class);
        registerPlugin(PolythPushPlugin.class);
        super.onCreate(savedInstanceState);
        installRenderProcessRecovery();
        if (!renderRecovery) routeNativePushOpen(getIntent());
    }

    /**
     * Without a handler, a dead WebView renderer (crash, a "bad IPC" kill, or
     * the system reclaiming it) makes Android kill the whole app. Capacitor's
     * BridgeWebViewClient forwards onRenderProcessGone to its WebViewListeners
     * and reports it handled when one returns true, so the hook is a listener
     * rather than a replacement client: request interception, navigation and
     * plugin traffic stay Capacitor's.
     *
     * A WebView whose renderer is gone cannot be used again (not even
     * reload()); it has to be destroyed. Recreating the activity does exactly
     * that (BridgeActivity.onDetachedFromWindow destroys it) and builds a fresh
     * bridge and WebView that loads the app again. RenderRecoveryBudget stops a
     * page that kills the renderer on every load from looping forever.
     */
    private void installRenderProcessRecovery() {
        if (getBridge() == null) return;
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                return recoverFromRenderProcessGone(detail);
            }
        });
    }

    private boolean recoverFromRenderProcessGone(RenderProcessGoneDetail detail) {
        String cause = "unknown";
        if (detail != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            cause = "didCrash=" + detail.didCrash() + " rendererPriorityAtExit=" + detail.rendererPriorityAtExit();
        }
        if (renderRecoveryScheduled) {
            Log.w(TAG, "WebView renderer gone again before recovery ran (" + cause + ")");
            return true;
        }
        renderRecoveryScheduled = true;
        if (!RENDER_RECOVERY.tryRecover(SystemClock.elapsedRealtime())) {
            Log.e(TAG, "WebView renderer gone repeatedly (" + cause + "); closing instead of reloading again");
            new Handler(Looper.getMainLooper()).post(() -> {
                if (!isFinishing() && !isDestroyed()) finish();
            });
            return true;
        }
        Log.w(TAG, "WebView renderer gone (" + cause + "); recreating the WebView");
        new Handler(Looper.getMainLooper()).post(() -> {
            if (isFinishing() || isDestroyed()) return;
            RECREATING_AFTER_RENDER_GONE.set(true);
            recreate();
        });
        return true;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        rememberPendingUrl(intent);
        super.onNewIntent(intent);
        routeNativePushOpen(intent);
    }
}
