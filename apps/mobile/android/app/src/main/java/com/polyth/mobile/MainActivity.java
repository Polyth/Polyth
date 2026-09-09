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

    @Override
    public void onCreate(Bundle savedInstanceState) {
        rememberPendingUrl(getIntent());
        registerPlugin(PolythLinkPlugin.class);
        registerPlugin(PolythDiscoveryPlugin.class);
        registerPlugin(PolythNavigationPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        rememberPendingUrl(intent);
        super.onNewIntent(intent);
    }
}
