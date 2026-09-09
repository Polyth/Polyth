package com.polyth.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.URI;

@CapacitorPlugin(name = "PolythNavigation")
public class PolythNavigationPlugin extends Plugin {
    private boolean trusted(PluginCall call) {
        try {
            String raw = getBridge().getWebView().getUrl();
            URI url = URI.create(raw == null ? "" : raw);
            if ("https".equalsIgnoreCase(url.getScheme())
                    && "localhost".equalsIgnoreCase(url.getHost())
                    && url.getPort() == -1) {
                return true;
            }
        } catch (Exception ignored) {}
        call.reject("forbidden", "forbidden");
        return false;
    }

    @PluginMethod
    public void consumePendingUrl(PluginCall call) {
        if (!trusted(call)) return;
        String url = MainActivity.consumePendingUrl();
        JSObject result = new JSObject();
        if (url != null && !url.isEmpty()) result.put("url", url);
        call.resolve(result);
    }
}
