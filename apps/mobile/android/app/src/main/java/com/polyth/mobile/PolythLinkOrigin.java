package com.polyth.mobile;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.PluginCall;

import java.net.URI;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/**
 * PolythLinkPlugin and PolythDiscoveryPlugin both must reject calls from any
 * WebView origin except the bundled app shell (capacitor.config.ts pins
 * androidScheme "https" + hostname "localhost"; see docs/architecture/
 * polyth-link.md's "Mobile proxy" trust boundary). One owner keeps the two
 * native plugins from drifting to different rules.
 */
final class PolythLinkOrigin {
    private static final String TAG = "PolythLinkOrigin";

    private static final long URL_READ_TIMEOUT_MS = 2000;

    private PolythLinkOrigin() {}

    /**
     * WebView methods are main-thread only, but Capacitor dispatches every
     * {@code @PluginMethod} on its "CapacitorPlugins" handler thread, where
     * {@code WebView.getUrl()} throws. Read the URL on the main looper and
     * fail closed (null, i.e. not trusted) if it cannot be read in time.
     */
    static String currentUrl(Bridge bridge) {
        WebView webView = bridge.getWebView();
        if (webView == null) return null;
        if (Looper.myLooper() == Looper.getMainLooper()) return webView.getUrl();
        FutureTask<String> read = new FutureTask<>(webView::getUrl);
        new Handler(Looper.getMainLooper()).post(read);
        try {
            return read.get(URL_READ_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            read.cancel(false);
            Thread.currentThread().interrupt();
            return null;
        } catch (Exception error) {
            read.cancel(false);
            Log.w(TAG, "Could not read the WebView URL on the main thread: " + error.getClass().getSimpleName());
            return null;
        }
    }

    static boolean isBundledOrigin(String rawUrl) {
        try {
            URI url = URI.create(rawUrl == null ? "" : rawUrl);
            return "https".equalsIgnoreCase(url.getScheme())
                && "localhost".equalsIgnoreCase(url.getHost())
                && url.getPort() == -1;
        } catch (Exception ignored) {
            return false;
        }
    }

    /**
     * Rejects the call with the bare "forbidden" code the JS layer already
     * expects, but first logs the mismatched scheme/host/port (never the
     * full URL, which may carry a query string) so a report of an
     * unexplained "forbidden" can be traced to the actual origin that
     * triggered it instead of only reproducing the symptom.
     */
    static boolean requireBundledOrigin(PluginCall call, String rawUrl) {
        if (isBundledOrigin(rawUrl)) return true;
        String scheme = "?";
        String host = "?";
        int port = -2;
        try {
            URI url = URI.create(rawUrl == null ? "" : rawUrl);
            scheme = String.valueOf(url.getScheme());
            host = String.valueOf(url.getHost());
            port = url.getPort();
        } catch (Exception ignored) {}
        Log.w(TAG, "Rejected a native call: WebView origin was " + scheme + "://" + host
            + (port >= 0 ? (":" + port) : "") + ", expected https://localhost");
        call.reject("forbidden", "forbidden");
        return false;
    }

    static boolean requireBundledOrigin(PluginCall call, Bridge bridge) {
        return requireBundledOrigin(call, currentUrl(bridge));
    }
}
