package com.polyth.mobile;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

@CapacitorPlugin(name = "PolythDiscovery")
public final class PolythDiscoveryPlugin extends Plugin {
    private static final String SERVICE_TYPE = "_polyth._udp.";
    private static final int EMPTY_DELAY_MS = 3000;

    private final Object lock = new Object();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, JSObject> results = new HashMap<>();
    private final Map<String, String> serviceToEndpoint = new HashMap<>();
    private final Set<String> activeServices = new HashSet<>();
    private final ArrayDeque<NsdServiceInfo> resolveQueue = new ArrayDeque<>();

    private NsdManager nsd;
    private NsdManager.DiscoveryListener listener;
    private WifiManager.MulticastLock multicastLock;
    private int generation;
    private boolean resolving;

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

    @Override
    public void load() {
        nsd = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
    }

    @Override
    protected void handleOnPause() {
        stopInternal();
        super.handleOnPause();
    }

    @Override
    protected void handleOnDestroy() {
        stopInternal();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        if (!trusted(call)) return;
        if (nsd == null) {
            call.reject("discovery-unavailable", "discovery-unavailable");
            return;
        }
        final int current;
        synchronized (lock) {
            stopLocked();
            current = ++generation;
            acquireMulticastLocked();
            listener = listener(current);
        }
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener);
            emit(current, "discovering", null);
            main.postDelayed(() -> emitEmptyIfNeeded(current), EMPTY_DELAY_MS);
            JSObject response = new JSObject();
            response.put("ok", true);
            call.resolve(response);
        } catch (SecurityException error) {
            stopInternal();
            call.reject("discovery-permission-denied", "discovery-permission-denied", error);
        } catch (Exception error) {
            stopInternal();
            call.reject("discovery-unavailable", "discovery-unavailable", error);
        }
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        if (!trusted(call)) return;
        stopInternal();
        JSObject response = new JSObject();
        response.put("ok", true);
        call.resolve(response);
    }

    private NsdManager.DiscoveryListener listener(int current) {
        return new NsdManager.DiscoveryListener() {
            @Override
            public void onDiscoveryStarted(String serviceType) {
                emit(current, "discovering", null);
            }

            @Override
            public void onServiceFound(NsdServiceInfo serviceInfo) {
                String name = safeServiceName(serviceInfo);
                if (name == null || !current(current)) return;
                synchronized (lock) {
                    if (!currentLocked(current)) return;
                    activeServices.add(name);
                    resolveQueue.addLast(serviceInfo);
                }
                resolveNext(current);
            }

            @Override
            public void onServiceLost(NsdServiceInfo serviceInfo) {
                String name = safeServiceName(serviceInfo);
                if (name == null || !current(current)) return;
                synchronized (lock) {
                    if (!currentLocked(current)) return;
                    activeServices.remove(name);
                    String endpoint = serviceToEndpoint.remove(name);
                    if (endpoint != null && !serviceToEndpoint.containsValue(endpoint)) {
                        results.remove(endpoint);
                    }
                }
                emit(current, snapshotEmpty(current) ? "discovering" : "results", null);
            }

            @Override
            public void onDiscoveryStopped(String serviceType) {}

            @Override
            public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                emit(current, "error", "discovery-unavailable");
                stopInternalIfCurrent(current);
            }

            @Override
            public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                stopInternalIfCurrent(current);
            }
        };
    }

    private void resolveNext(int current) {
        final NsdServiceInfo service;
        synchronized (lock) {
            if (!currentLocked(current) || resolving) return;
            service = resolveQueue.pollFirst();
            if (service == null) return;
            resolving = true;
        }
        try {
            nsd.resolveService(service, new NsdManager.ResolveListener() {
                @Override
                public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                    finishResolve(current);
                }

                @Override
                public void onServiceResolved(NsdServiceInfo serviceInfo) {
                    acceptResolved(current, serviceInfo);
                    finishResolve(current);
                }
            });
        } catch (Exception ignored) {
            finishResolve(current);
        }
    }

    private void finishResolve(int current) {
        synchronized (lock) {
            if (currentLocked(current)) resolving = false;
        }
        resolveNext(current);
    }

    private void acceptResolved(int current, NsdServiceInfo serviceInfo) {
        String serviceName = safeServiceName(serviceInfo);
        if (serviceName == null) return;
        String endpoint = attribute(serviceInfo, "endpoint");
        String version = attribute(serviceInfo, "v");
        if (!validEndpoint(endpoint) || !"1".equals(version)) return;
        int port = serviceInfo.getPort();
        if (port < 1 || port > 65535) return;

        JSObject item = new JSObject();
        item.put("id", endpoint);
        item.put("serviceName", serviceName);
        item.put("hostLabel", safeLabel(attribute(serviceInfo, "label"), serviceName));
        item.put("hostEndpointId", endpoint);
        item.put("protocolVersion", 1);
        item.put("port", port);
        item.put("numericPairing", "1".equals(attribute(serviceInfo, "code")));
        JSArray addresses = new JSArray();
        if (serviceInfo.getHost() != null) {
            String address = serviceInfo.getHost().getHostAddress();
            if (address != null && address.length() <= 64) addresses.put(address);
        }
        item.put("addresses", addresses);

        synchronized (lock) {
            if (!currentLocked(current) || !activeServices.contains(serviceName)) return;
            serviceToEndpoint.put(serviceName, endpoint);
            results.put(endpoint, item);
        }
        emit(current, "results", null);
    }

    private String attribute(NsdServiceInfo serviceInfo, String key) {
        try {
            byte[] raw = serviceInfo.getAttributes().get(key);
            if (raw == null || raw.length == 0 || raw.length > 128) return null;
            String value = new String(raw, StandardCharsets.UTF_8);
            if (!StandardCharsets.UTF_8.newEncoder().canEncode(value)) return null;
            return value;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static boolean validEndpoint(String value) {
        if (value == null || value.length() < 32 || value.length() > 64) return false;
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (!Character.isLetterOrDigit(ch)) return false;
        }
        return true;
    }

    private static String safeServiceName(NsdServiceInfo serviceInfo) {
        if (serviceInfo == null) return null;
        String name = serviceInfo.getServiceName();
        if (name == null || name.isBlank() || name.length() > 128) return null;
        for (int i = 0; i < name.length(); i++) {
            if (Character.isISOControl(name.charAt(i))) return null;
        }
        return name;
    }

    private static String safeLabel(String candidate, String fallback) {
        String value = candidate == null || candidate.isBlank() ? fallback : candidate.trim();
        if (value.length() > 80) value = value.substring(0, 80);
        StringBuilder clean = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (!Character.isISOControl(ch)) clean.append(ch);
        }
        return clean.length() == 0 ? "Polyth" : clean.toString();
    }

    private void emitEmptyIfNeeded(int current) {
        if (snapshotEmpty(current)) emit(current, "empty", null);
    }

    private boolean snapshotEmpty(int current) {
        synchronized (lock) {
            return currentLocked(current) && results.isEmpty();
        }
    }

    private void emit(int current, String state, String error) {
        final List<JSObject> snapshot;
        synchronized (lock) {
            if (!currentLocked(current)) return;
            snapshot = new ArrayList<>(results.values());
        }
        snapshot.sort(Comparator.comparing(item -> item.optString("hostLabel", "Polyth"), String.CASE_INSENSITIVE_ORDER));
        JSArray items = new JSArray();
        for (JSObject item : snapshot) items.put(item);
        JSObject payload = new JSObject();
        payload.put("state", state);
        payload.put("results", items);
        if (error != null) payload.put("error", error);
        notifyListeners("discoveryChanged", payload);
    }

    private boolean current(int current) {
        synchronized (lock) {
            return currentLocked(current);
        }
    }

    private boolean currentLocked(int current) {
        return current == generation && listener != null;
    }

    private void acquireMulticastLocked() {
        try {
            WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi == null) return;
            multicastLock = wifi.createMulticastLock("polyth-discovery");
            multicastLock.setReferenceCounted(false);
            multicastLock.acquire();
        } catch (Exception ignored) {
            multicastLock = null;
        }
    }

    private void stopInternalIfCurrent(int current) {
        synchronized (lock) {
            if (!currentLocked(current)) return;
        }
        stopInternal();
    }

    private void stopInternal() {
        synchronized (lock) {
            stopLocked();
            generation++;
        }
    }

    private void stopLocked() {
        NsdManager.DiscoveryListener previous = listener;
        listener = null;
        results.clear();
        serviceToEndpoint.clear();
        activeServices.clear();
        resolveQueue.clear();
        resolving = false;
        if (previous != null && nsd != null) {
            try { nsd.stopServiceDiscovery(previous); } catch (Exception ignored) {}
        }
        if (multicastLock != null) {
            try {
                if (multicastLock.isHeld()) multicastLock.release();
            } catch (Exception ignored) {}
            multicastLock = null;
        }
    }
}
