package com.polyth.mobile;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import java.util.concurrent.atomic.AtomicReference;

public class MainActivity extends BridgeActivity {
    private static final AtomicReference<String> PENDING_URL = new AtomicReference<>();

    private static void rememberPendingUrl(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri data = intent.getData();
        if (data != null) PENDING_URL.set(data.toString());
    }

    static String consumePendingUrl() {
        return PENDING_URL.getAndSet(null);
    }

    /** A locally-generated notification tap never carries a URL. Route it to
     * the bundled hub, which alone consumes the validated native pending id
     * and reconnects the saved mapping. */
    private void routeNativePushOpen(Intent intent) {
        if (intent == null || getBridge() == null || !PolythPushPlugin.recordTap(getApplicationContext(), intent)) return;
        getBridge().getWebView().loadUrl("https://localhost");
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        rememberPendingUrl(getIntent());
        registerPlugin(PolythLinkPlugin.class);
        registerPlugin(PolythDiscoveryPlugin.class);
        registerPlugin(PolythNavigationPlugin.class);
        registerPlugin(PolythPushPlugin.class);
        super.onCreate(savedInstanceState);
        routeNativePushOpen(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        rememberPendingUrl(intent);
        super.onNewIntent(intent);
        routeNativePushOpen(intent);
    }
}
