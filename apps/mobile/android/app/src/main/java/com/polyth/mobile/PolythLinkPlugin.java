package com.polyth.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.common.moduleinstall.InstallStatusListener;
import com.google.android.gms.common.moduleinstall.ModuleInstall;
import com.google.android.gms.common.moduleinstall.ModuleInstallClient;
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest;
import com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "PolythLink")
public final class PolythLinkPlugin extends Plugin {
    private static final String PREFS = "polyth_link_secure";
    private static final String STATE_PREFS = "polyth_link_state";
    private static final String LAST_CONNECTION = "last_connection_id";
    private static final String ACTIVE_PROXY_ORIGIN = "active_proxy_origin";
    private static final String PROXY_RECOVERY_ATTEMPTS = "proxy_recovery_attempts";
    private static final int MAX_AUTOMATIC_PROXY_RECOVERIES = 2;
    private static final String KEY_PREFIX = "polyth-link-";
    private static final int SECRET_LENGTH = 32;
    private static final long SCANNER_MODULE_TIMEOUT_MS = 60_000;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final ExecutorService controlExecutor = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String, PairingSecretRecord> attempts = new ConcurrentHashMap<>();
    private volatile long clientHandle;
    private final AtomicBoolean recoveryInFlight = new AtomicBoolean(false);
    private final AtomicBoolean recoveryScheduled = new AtomicBoolean(false);
    private final AtomicLong recoveryGeneration = new AtomicLong();
    private static final long SERVER_CHOICE_LIFETIME_MS = 60_000;
    /** Main thread only. The server picked from the server menu, for the hub to open. */
    private String pendingServerChoice;
    private long pendingServerChoiceAt;
    private PolythServerMenu serverMenu;

    private static final class LinkFailure extends Exception {
        final String code;

        LinkFailure(String code) {
            super(code);
            this.code = code;
        }
    }

    private record PairingSecretRecord(String hostId, boolean createdForAttempt) {}

    private final class SecureStore {
        private final SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        private String alias(String hostId) throws Exception {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(hostId.getBytes(StandardCharsets.UTF_8));
            return KEY_PREFIX + Base64.encodeToString(digest, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        }

        private KeyStore keyStore() throws Exception {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            return store;
        }

        private SecretKey encryptionKey(String hostId, boolean create) throws Exception {
            String alias = alias(hostId);
            KeyStore store = keyStore();
            if (store.containsAlias(alias)) {
                return (SecretKey) store.getKey(alias, null);
            }
            if (!create) return null;
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .setUserAuthenticationRequired(false)
                .build());
            return generator.generateKey();
        }

        byte[] load(String hostId) throws LinkFailure {
            String encoded = prefs.getString(hostId, null);
            if (encoded == null) return null;
            try {
                SecretKey key = encryptionKey(hostId, false);
                if (key == null) throw new LinkFailure("host-identity-unavailable");
                byte[] blob = Base64.decode(encoded, Base64.NO_WRAP);
                if (blob.length < 2) throw new LinkFailure("host-identity-unavailable");
                int ivLength = blob[0] & 0xff;
                if (ivLength < 12 || blob.length <= 1 + ivLength) throw new LinkFailure("host-identity-unavailable");
                byte[] iv = Arrays.copyOfRange(blob, 1, 1 + ivLength);
                byte[] ciphertext = Arrays.copyOfRange(blob, 1 + ivLength, blob.length);
                try {
                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                    cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
                    byte[] secret = cipher.doFinal(ciphertext);
                    if (secret.length != SECRET_LENGTH) {
                        Arrays.fill(secret, (byte) 0);
                        throw new LinkFailure("host-identity-unavailable");
                    }
                    return secret;
                } finally {
                    Arrays.fill(iv, (byte) 0);
                    Arrays.fill(ciphertext, (byte) 0);
                    Arrays.fill(blob, (byte) 0);
                }
            } catch (LinkFailure error) {
                throw error;
            } catch (Exception error) {
                throw new LinkFailure("host-identity-unavailable");
            }
        }

        void store(String hostId, byte[] secret) throws LinkFailure {
            if (secret == null || secret.length != SECRET_LENGTH) throw new LinkFailure("pairing-storage-failed");
            try {
                SecretKey key = encryptionKey(hostId, true);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, key);
                byte[] iv = cipher.getIV();
                byte[] ciphertext = cipher.doFinal(secret);
                byte[] blob = new byte[1 + iv.length + ciphertext.length];
                blob[0] = (byte) iv.length;
                System.arraycopy(iv, 0, blob, 1, iv.length);
                System.arraycopy(ciphertext, 0, blob, 1 + iv.length, ciphertext.length);
                try {
                    if (!prefs.edit().putString(hostId, Base64.encodeToString(blob, Base64.NO_WRAP)).commit()) {
                        throw new LinkFailure("pairing-storage-failed");
                    }
                } finally {
                    Arrays.fill(ciphertext, (byte) 0);
                    Arrays.fill(blob, (byte) 0);
                }
            } catch (LinkFailure error) {
                throw error;
            } catch (Exception error) {
                throw new LinkFailure("pairing-storage-failed");
            }
        }

        void delete(String hostId) throws LinkFailure {
            try {
                if (!prefs.edit().remove(hostId).commit()) throw new LinkFailure("pairing-storage-failed");
                KeyStore store = keyStore();
                String alias = alias(hostId);
                if (store.containsAlias(alias)) store.deleteEntry(alias);
            } catch (LinkFailure error) {
                throw error;
            } catch (Exception error) {
                throw new LinkFailure("pairing-storage-failed");
            }
        }

        Set<String> hostIds() {
            return new HashSet<>(prefs.getAll().keySet());
        }
    }

    private SecureStore secureStore;
    private SharedPreferences statePrefs;

    @Override
    public void load() {
        secureStore = new SecureStore();
        statePrefs = getContext().getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (recoveryScheduled.compareAndSet(false, true)) restoreLoopbackTransport();
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (serverMenu != null) serverMenu.dismissNow();
        recoveryGeneration.incrementAndGet();
        recoveryInFlight.set(false);
        recoveryScheduled.set(false);
        // The renderer closes its WebSocket and cancels retry timers. Do not
        // manufacture a disconnect here: the OS may suspend the native link,
        // and foreground status must distinguish a healthy suspended proxy
        // from one that actually died.
    }

    @Override
    protected void handleOnDestroy() {
        long handle = clientHandle;
        clientHandle = 0;
        if (handle != 0 && PolythLinkRust.isAvailable()) PolythLinkRust.clientFree(handle);
        executor.shutdownNow();
        controlExecutor.shutdownNow();
        super.handleOnDestroy();
    }

    private boolean trusted(PluginCall call) {
        return PolythLinkOrigin.requireBundledOrigin(call, getBridge());
    }

    static boolean ownsCurrentProxy(Context context, String raw) {
        try {
            URI url = URI.create(raw == null ? "" : raw);
            String current = canonicalLoopbackOrigin(url);
            SharedPreferences prefs = context.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE);
            return current != null && current.equals(prefs.getString(ACTIVE_PROXY_ORIGIN, null))
                && prefs.getString(LAST_CONNECTION, null) != null;
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean loopbackContent() {
        return ownsCurrentProxy(getContext(), PolythLinkOrigin.currentUrl(getBridge()));
    }

    private static String canonicalLoopbackOrigin(URI url) {
        return "http".equalsIgnoreCase(url.getScheme()) && "127.0.0.1".equals(url.getHost()) && url.getPort() > 0
            ? "http://127.0.0.1:" + url.getPort()
            : null;
    }

    private static String launchOrigin(JSONObject launch) {
        try { return canonicalLoopbackOrigin(URI.create(launch.optString("origin", ""))); }
        catch (Exception ignored) { return null; }
    }

    private String require(PluginCall call, String key, String code) {
        String value = call.getString(key);
        if (value == null || value.isEmpty()) {
            call.reject(code, code);
            return null;
        }
        return value;
    }

    private void reject(PluginCall call, Exception error) {
        String code = error instanceof LinkFailure ? ((LinkFailure) error).code : "transport-protocol-error";
        call.reject(code, code, error);
    }

    /** Fail closed when the native core could not load: the documented
     * unavailable state, never an uncaught LinkageError that ends the process. */
    private static void requireNative() throws LinkFailure {
        if (!PolythLinkRust.isAvailable()) throw new LinkFailure("transport-unavailable");
    }

    private synchronized long ensureClient() throws LinkFailure {
        if (clientHandle != 0) return clientHandle;
        requireNative();
        try {
            File dataDir = new File(getContext().getNoBackupFilesDir(), "polyth-link");
            if (!dataDir.exists() && !dataDir.mkdirs()) throw new LinkFailure("pairing-storage-failed");
            File webDir = prepareWebAssets();
            clientHandle = PolythLinkRust.clientNew(dataDir.getAbsolutePath(), webDir.getAbsolutePath());
            if (clientHandle == 0) throw new LinkFailure("transport-unavailable");
            return clientHandle;
        } catch (LinkFailure error) {
            throw error;
        } catch (Exception | LinkageError error) {
            throw new LinkFailure("transport-unavailable");
        }
    }

    private File prepareWebAssets() throws Exception {
        long version;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            version = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).getLongVersionCode();
        } else {
            version = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionCode;
        }
        File root = new File(getContext().getCodeCacheDir(), "polyth-link-web-" + version);
        File ready = new File(root, ".ready");
        if (ready.isFile()) return root;
        deleteTree(root);
        if (!root.mkdirs()) throw new IllegalStateException("web asset directory");
        copyAssetTree(getContext().getAssets(), "public", root);
        if (!ready.createNewFile()) throw new IllegalStateException("web asset marker");
        return root;
    }

    private static void copyAssetTree(AssetManager assets, String source, File destination) throws Exception {
        String[] children = assets.list(source);
        if (children != null && children.length > 0) {
            if (!destination.exists() && !destination.mkdirs()) throw new IllegalStateException("asset directory");
            for (String child : children) copyAssetTree(assets, source + "/" + child, new File(destination, child));
            return;
        }
        File parent = destination.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IllegalStateException("asset parent");
        try (InputStream input = assets.open(source); FileOutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            Arrays.fill(buffer, (byte) 0);
        }
    }

    private static void deleteTree(File file) {
        if (!file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private String hostId(String ticket) throws LinkFailure {
        requireNative();
        String hostId = PolythLinkRust.ticketHostId(ticket);
        if (hostId == null || hostId.isEmpty()) throw new LinkFailure("pairing-invalid");
        return hostId;
    }

    private Object invoke(String method, JSObject params, byte[] secret) throws Exception {
        long handle = ensureClient();
        try {
            String raw = PolythLinkRust.invoke(handle, method, params.toString(), secret);
            if (raw == null) throw new LinkFailure("transport-protocol-error");
            JSONObject envelope = new JSONObject(raw);
            if (!envelope.optBoolean("ok", false)) throw new LinkFailure(envelope.optString("error", "transport-protocol-error"));
            return envelope.opt("result");
        } finally {
            if (secret != null) Arrays.fill(secret, (byte) 0);
        }
    }

    private JSONObject invokeObject(String method, JSObject params, byte[] secret) throws Exception {
        Object value = invoke(method, params, secret);
        if (!(value instanceof JSONObject)) throw new LinkFailure("transport-protocol-error");
        return (JSONObject) value;
    }

    private JSONArray invokeArray(String method, JSObject params) throws Exception {
        Object value = invoke(method, params, null);
        if (!(value instanceof JSONArray)) throw new LinkFailure("transport-protocol-error");
        return (JSONArray) value;
    }

    private JSONArray listAndCleanOrphans() throws Exception {
        JSONArray raw = invokeArray("connections.list", new JSObject());
        Set<String> keep = new HashSet<>();
        for (int i = 0; i < raw.length(); i++) {
            String hostId = raw.getJSONObject(i).optString("hostEndpointId", "");
            if (!hostId.isEmpty()) keep.add(hostId);
        }
        for (PairingSecretRecord attempt : attempts.values()) keep.add(attempt.hostId());
        for (String hostId : secureStore.hostIds()) {
            if (!keep.contains(hostId)) secureStore.delete(hostId);
        }
        return raw;
    }

    private boolean hasConnectionMetadata(String hostId) throws Exception {
        return connectionMetadata(hostId) != null;
    }

    private JSONObject connectionMetadata(String hostId) throws Exception {
        JSONArray raw = invokeArray("connections.list", new JSObject());
        for (int i = 0; i < raw.length(); i++) {
            JSONObject item = raw.getJSONObject(i);
            if (hostId.equals(item.optString("hostEndpointId", ""))) return item;
        }
        return null;
    }

    private void rememberTransport(String connectionId, JSONObject launch) throws LinkFailure {
        String origin = launchOrigin(launch);
        if (origin == null) throw new LinkFailure("proxy-bootstrap-invalid");
        statePrefs.edit().putString(LAST_CONNECTION, connectionId)
            .putString(ACTIVE_PROXY_ORIGIN, origin).putInt(PROXY_RECOVERY_ATTEMPTS, 0).apply();
    }

    private void forgetTransport(String connectionId) {
        if (connectionId.equals(statePrefs.getString(LAST_CONNECTION, null))) {
            statePrefs.edit().remove(LAST_CONNECTION).remove(ACTIVE_PROXY_ORIGIN).apply();
        }
    }

    private void restoreLoopbackTransport() {
        if (!loopbackContent()) return;
        String connectionId = statePrefs.getString(LAST_CONNECTION, null);
        if (connectionId == null || connectionId.isEmpty()) return;
        if (!recoveryInFlight.compareAndSet(false, true)) return;
        long generation = recoveryGeneration.incrementAndGet();
        controlExecutor.execute(() -> {
            try {
                JSONObject status = invokeObject("status", new JSObject().put("connectionId", connectionId), null);
                if ("connected".equals(status.optString("state", ""))) {
                    statePrefs.edit().putInt(PROXY_RECOVERY_ATTEMPTS, 0).apply();
                    return;
                }
                int attempts = statePrefs.getInt(PROXY_RECOVERY_ATTEMPTS, 0);
                if (attempts >= MAX_AUTOMATIC_PROXY_RECOVERIES) {
                    showRecoveryHub(generation);
                    return;
                }
                statePrefs.edit().putInt(PROXY_RECOVERY_ATTEMPTS, attempts + 1).apply();
                byte[] secret = secureStore.load(connectionId);
                if (secret == null) throw new LinkFailure("host-identity-unavailable");
                JSONObject result = invokeObject("connect", new JSObject().put("connectionId", connectionId), secret);
                String bootstrap = result.optString("bootstrapUrl", result.optString("bootstrap", ""));
                if (bootstrap.isEmpty()) throw new LinkFailure("proxy-bootstrap-invalid");
                String target = bootstrapWithCurrentPath(bootstrap);
                getActivity().runOnUiThread(() -> {
                    if (!recoveryCurrent(generation)) return;
                    try {
                        rememberTransport(connectionId, result);
                        getBridge().getWebView().loadUrl(target);
                    } catch (LinkFailure error) {
                        showRecoveryHub(generation);
                    }
                });
            } catch (Exception error) {
                showRecoveryHub(generation);
            } finally {
                if (recoveryGeneration.get() == generation) recoveryInFlight.set(false);
            }
        });
    }

    private boolean recoveryCurrent(long generation) {
        return recoveryGeneration.get() == generation && loopbackContent();
    }

    private void showRecoveryHub(long generation) {
        getActivity().runOnUiThread(() -> {
            if (recoveryCurrent(generation)) {
                getBridge().getWebView().loadUrl("https://localhost/?connectionError=proxy-recovery-failed");
            }
        });
    }

    private String bootstrapWithCurrentPath(String bootstrap) {
        try {
            URI current = URI.create(PolythLinkOrigin.currentUrl(getBridge()));
            String path = current.getPath();
            if (path == null || !path.startsWith("/") || path.startsWith("//") || path.contains("\\") || path.contains("\r") || path.contains("\n")) {
                return bootstrap;
            }
            if (current.getQuery() != null && !current.getQuery().isEmpty()) path += "?" + current.getQuery();
            URI target = URI.create(bootstrap);
            if (target.getRawFragment() != null) return bootstrap;
            String separator = target.getRawQuery() == null ? "?" : "&";
            return bootstrap + separator + "next=" + URLEncoder.encode(path, StandardCharsets.UTF_8.name());
        } catch (Exception ignored) {
            return bootstrap;
        }
    }

    /**
     * The server button of the open server's page. Only that page (the proxy
     * this app opened) or the hub may ask, and the list never crosses into
     * JavaScript: the page learns only the kind of choice. A picked server is
     * held here for the bundled hub, which opens it ({@link #consumeServerChoice}).
     */
    @PluginMethod
    public void presentServerMenu(PluginCall call) {
        String url = PolythLinkOrigin.currentUrl(getBridge());
        if (!ownsCurrentProxy(getContext(), url) && !PolythLinkOrigin.isBundledOrigin(url)) {
            call.reject("forbidden", "forbidden");
            return;
        }
        Double x = call.getDouble("x");
        Double y = call.getDouble("y");
        Double width = call.getDouble("width");
        Double height = call.getDouble("height");
        if (x == null || y == null || width == null || height == null
            || !Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(width) || !Double.isFinite(height)
            || width < 0 || height < 0) {
            call.reject("menu-invalid", "menu-invalid");
            return;
        }
        executor.execute(() -> {
            List<PolythServerMenu.Item> items;
            try { items = serverMenuItems(); } catch (Exception error) { reject(call, error); return; }
            getActivity().runOnUiThread(() -> showServerMenu(call, items,
                x.floatValue(), y.floatValue(), width.floatValue(), height.floatValue()));
        });
    }

    @PluginMethod
    public void consumeServerChoice(PluginCall call) {
        if (!trusted(call)) return;
        getActivity().runOnUiThread(() -> {
            String choice = pendingServerChoice;
            long at = pendingServerChoiceAt;
            pendingServerChoice = null;
            if (choice == null || System.currentTimeMillis() - at >= SERVER_CHOICE_LIFETIME_MS) {
                call.resolve(new JSObject());
                return;
            }
            call.resolve(new JSObject().put("connectionId", choice));
        });
    }

    /** Newest first, the open server on top. Reads only; orphan cleanup stays with the hub. */
    private List<PolythServerMenu.Item> serverMenuItems() throws Exception {
        JSONArray raw = invokeArray("connections.list", new JSObject());
        List<JSONObject> connections = new ArrayList<>();
        for (int i = 0; i < raw.length(); i++) connections.add(raw.getJSONObject(i));
        connections.sort((a, b) -> Double.compare(b.optDouble("lastUsedAt", 0), a.optDouble("lastUsedAt", 0)));
        String current = statePrefs.getString(LAST_CONNECTION, null);
        List<PolythServerMenu.Item> open = new ArrayList<>();
        List<PolythServerMenu.Item> others = new ArrayList<>();
        for (JSONObject connection : connections) {
            String id = connection.optString("id", "");
            if (id.isEmpty()) continue;
            String hostId = connection.optString("hostEndpointId", id);
            boolean hasIdentity = false;
            try {
                byte[] secret = secureStore.load(hostId);
                hasIdentity = secret != null;
                if (secret != null) Arrays.fill(secret, (byte) 0);
            } catch (LinkFailure ignored) {}
            String state = connection.optString("pairingState", "");
            boolean revoked = connection.optBoolean("revoked", false) || "revoked".equals(state);
            boolean isCurrent = id.equals(current);
            String label = connection.optString("hostLabel", "");
            if (label.isEmpty()) label = "Polyth";
            String detail;
            String tone;
            if (isCurrent) { detail = "Connected"; tone = "connected"; }
            else if (revoked) { detail = "Revoked"; tone = "danger"; }
            else if (!hasIdentity) { detail = "Pair again to use"; tone = "warning"; }
            else if ("prepared".equals(state)) { detail = "Pairing interrupted"; tone = "warning"; }
            else { detail = "relay".equals(connection.optString("lastTransport", "")) ? "Ready \u00b7 via relay" : "Ready"; tone = "ready"; }
            PolythServerMenu.Item item = new PolythServerMenu.Item(
                id, label, detail, isCurrent, isCurrent || (!revoked && hasIdentity), tone);
            (isCurrent ? open : others).add(item);
        }
        open.addAll(others);
        return open;
    }

    private void showServerMenu(PluginCall call, List<PolythServerMenu.Item> items, float x, float y, float width, float height) {
        if (serverMenu != null) { call.reject("busy", "busy"); return; }
        String url = PolythLinkOrigin.currentUrl(getBridge());
        if ((!ownsCurrentProxy(getContext(), url) && !PolythLinkOrigin.isBundledOrigin(url)) || getBridge().getWebView() == null) {
            call.reject("forbidden", "forbidden");
            return;
        }
        String current = null;
        for (PolythServerMenu.Item item : items) if (item.current) current = item.id;
        String open = current;
        serverMenu = new PolythServerMenu(getActivity(), getBridge().getWebView(), (kind, connectionId) -> {
            serverMenu = null;
            if ("server".equals(kind) && connectionId != null && connectionId.equals(open)) {
                call.resolve(new JSObject().put("action", "current"));
            } else if ("server".equals(kind) && connectionId != null) {
                pendingServerChoice = connectionId;
                pendingServerChoiceAt = System.currentTimeMillis();
                call.resolve(new JSObject().put("action", "switch"));
            } else if ("add".equals(kind)) {
                pendingServerChoice = null;
                call.resolve(new JSObject().put("action", "add"));
            } else {
                call.resolve(new JSObject().put("action", "cancel"));
            }
        });
        serverMenu.show(items, x, y, width, height);
    }

    @PluginMethod
    public void scanPairingQr(PluginCall call) {
        if (!trusted(call)) return;
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAutoZoom()
            .build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(getActivity(), options);
        // The scanner UI is a Play services optional module. The manifest
        // dependency only pre-downloads it for Play Store installs; otherwise the
        // first startScan() fails while the module downloads and only a retry
        // opens the camera. Wait for the module before starting the scan.
        ModuleInstallClient modules = ModuleInstall.getClient(getContext());
        AtomicBoolean settled = new AtomicBoolean(false);
        Handler main = new Handler(Looper.getMainLooper());
        InstallStatusListener listener = new InstallStatusListener() {
            @Override
            public void onInstallStatusUpdated(ModuleInstallStatusUpdate update) {
                int state = update.getInstallState();
                if (state != ModuleInstallStatusUpdate.InstallState.STATE_COMPLETED
                    && state != ModuleInstallStatusUpdate.InstallState.STATE_FAILED
                    && state != ModuleInstallStatusUpdate.InstallState.STATE_CANCELED) return;
                modules.unregisterListener(this);
                if (!settled.compareAndSet(false, true)) return;
                if (state == ModuleInstallStatusUpdate.InstallState.STATE_COMPLETED) startPairingScan(call, scanner);
                else call.reject("camera-scan-failed", "camera-scan-failed");
            }
        };
        ModuleInstallRequest request = ModuleInstallRequest.newBuilder().addApi(scanner).setListener(listener).build();
        modules.installModules(request)
            .addOnSuccessListener(response -> {
                if (!response.areModulesAlreadyInstalled()) return;
                modules.unregisterListener(listener);
                if (settled.compareAndSet(false, true)) startPairingScan(call, scanner);
            })
            .addOnFailureListener(error -> {
                modules.unregisterListener(listener);
                // Fall back to a direct scan: older Play services may lack the
                // install API while still providing the scanner.
                if (settled.compareAndSet(false, true)) startPairingScan(call, scanner);
            });
        main.postDelayed(() -> {
            if (!settled.compareAndSet(false, true)) return;
            modules.unregisterListener(listener);
            call.reject("camera-scan-failed", "camera-scan-failed");
        }, SCANNER_MODULE_TIMEOUT_MS);
    }

    private void startPairingScan(PluginCall call, GmsBarcodeScanner scanner) {
        scanner.startScan()
            .addOnSuccessListener(barcode -> {
                String raw = barcode.getRawValue();
                call.resolve(raw == null ? new JSObject() : new JSObject().put("raw", raw));
            })
            .addOnCanceledListener(() -> call.resolve(new JSObject()))
            .addOnFailureListener(error -> call.reject("camera-scan-failed", "camera-scan-failed", error));
    }

    @PluginMethod
    public void parsePairingTicket(PluginCall call) {
        if (!trusted(call)) return;
        String raw = require(call, "raw", "pairing-invalid");
        if (raw == null) return;
        executor.execute(() -> {
            try { call.resolve(JSObject.fromJSONObject(invokeObject("pairing.parse", new JSObject().put("ticket", raw), null))); }
            catch (Exception error) { reject(call, error); }
        });
    }

    @PluginMethod
    public void beginPairing(PluginCall call) {
        if (!trusted(call)) return;
        String raw = require(call, "raw", "pairing-invalid");
        if (raw == null) return;
        String label = call.getString("label", "This phone");
        executor.execute(() -> {
            String hostKey = null;
            byte[] secret = null;
            boolean created = false;
            try {
                hostKey = hostId(raw);
                secret = secureStore.load(hostKey);
                created = secret == null;
                if (secret == null) {
                    secret = PolythLinkRust.generateIdentitySecret();
                    if (secret == null || secret.length != SECRET_LENGTH) throw new LinkFailure("pairing-storage-failed");
                    secureStore.store(hostKey, secret);
                }
                JSONObject result = invokeObject("pairing.begin", new JSObject().put("ticket", raw).put("label", label), secret);
                String attemptId = result.optString("attemptId", "");
                if (attemptId.isEmpty()) throw new LinkFailure("transport-protocol-error");
                attempts.put(attemptId, new PairingSecretRecord(hostKey, created));
                call.resolve(JSObject.fromJSONObject(result));
            } catch (Exception error) {
                if (created && hostKey != null) try { secureStore.delete(hostKey); } catch (Exception ignored) {}
                reject(call, error);
            } finally {
                if (secret != null) Arrays.fill(secret, (byte) 0);
            }
        });
    }

    @PluginMethod
    public void beginNumericPairing(PluginCall call) {
        if (!trusted(call)) return;
        String hostKey = require(call, "hostEndpointId", "pairing-invalid");
        String code = require(call, "code", "pairing-invalid");
        if (hostKey == null || code == null) return;
        String label = call.getString("label", "This phone");
        JSArray addresses = call.getArray("addresses", new JSArray());
        Integer port = call.getInt("port");
        executor.execute(() -> {
            byte[] secret = null;
            boolean created = false;
            try {
                secret = secureStore.load(hostKey);
                created = secret == null;
                if (secret == null) {
                    requireNative();
                    secret = PolythLinkRust.generateIdentitySecret();
                    if (secret == null || secret.length != SECRET_LENGTH) throw new LinkFailure("pairing-storage-failed");
                    secureStore.store(hostKey, secret);
                }
                JSObject params = new JSObject()
                    .put("hostEndpointId", hostKey)
                    .put("addresses", addresses)
                    .put("code", code)
                    .put("label", label);
                if (port != null) params.put("port", port);
                JSONObject result = invokeObject("pairing.begin_numeric", params, secret);
                String attemptId = result.optString("attemptId", "");
                if (attemptId.isEmpty()) throw new LinkFailure("transport-protocol-error");
                attempts.put(attemptId, new PairingSecretRecord(hostKey, created));
                call.resolve(JSObject.fromJSONObject(result));
            } catch (Exception error) {
                if (created) try { secureStore.delete(hostKey); } catch (Exception ignored) {}
                reject(call, error);
            } finally {
                if (secret != null) Arrays.fill(secret, (byte) 0);
            }
        });
    }

    @PluginMethod
    public void confirmPairing(PluginCall call) {
        if (!trusted(call)) return;
        String attemptId = require(call, "attemptId", "pairing-invalid");
        if (attemptId == null) return;
        executor.execute(() -> {
            try {
                JSONObject result = invokeObject("pairing.confirm", new JSObject().put("attemptId", attemptId), null);
                attempts.remove(attemptId);
                String connectionId = result.optString("connectionId", "");
                if (!connectionId.isEmpty()) rememberTransport(connectionId, result);
                call.resolve(JSObject.fromJSONObject(result));
            } catch (Exception error) { reject(call, error); }
        });
    }

    @PluginMethod
    public void cancelPairing(PluginCall call) {
        if (!trusted(call)) return;
        String attemptId = require(call, "attemptId", "pairing-invalid");
        if (attemptId == null) return;
        controlExecutor.execute(() -> {
            try {
                invoke("pairing.cancel", new JSObject().put("attemptId", attemptId), null);
                PairingSecretRecord record = attempts.remove(attemptId);
                if (record != null && record.createdForAttempt() && !hasConnectionMetadata(record.hostId())) {
                    secureStore.delete(record.hostId());
                }
                call.resolve(new JSObject().put("ok", true));
            } catch (Exception error) { reject(call, error); }
        });
    }

    @PluginMethod
    public void listConnections(PluginCall call) {
        if (!trusted(call)) return;
        executor.execute(() -> {
            try {
                JSONArray raw = listAndCleanOrphans();
                JSArray connections = new JSArray();
                for (int i = 0; i < raw.length(); i++) {
                    JSONObject item = raw.getJSONObject(i);
                    String hostId = item.optString("hostEndpointId", "");
                    boolean hasIdentity = false;
                    if (!hostId.isEmpty()) {
                        try {
                            byte[] secret = secureStore.load(hostId);
                            hasIdentity = secret != null;
                            if (secret != null) Arrays.fill(secret, (byte) 0);
                        } catch (LinkFailure ignored) {}
                    }
                    item.put("hasSecureIdentity", hasIdentity);
                    connections.put(JSObject.fromJSONObject(item));
                }
                call.resolve(new JSObject().put("connections", connections));
            } catch (Exception error) { reject(call, error); }
        });
    }

    @PluginMethod
    public void connect(PluginCall call) {
        if (!trusted(call)) return;
        String connectionId = require(call, "connectionId", "device-unknown");
        if (connectionId == null) return;
        executor.execute(() -> {
            try {
                byte[] secret = secureStore.load(connectionId);
                if (secret == null) throw new LinkFailure("host-identity-unavailable");
                JSONObject result = invokeObject("connect", new JSObject().put("connectionId", connectionId), secret);
                rememberTransport(connectionId, result);
                call.resolve(JSObject.fromJSONObject(result));
            } catch (Exception error) { reject(call, error); }
        });
    }

    @PluginMethod
    public void recoverConnection(PluginCall call) {
        if (!trusted(call)) return;
        String connectionId = require(call, "connectionId", "device-unknown");
        if (connectionId == null) return;
        executor.execute(() -> {
            try {
                byte[] secret = secureStore.load(connectionId);
                if (secret == null) throw new LinkFailure("host-identity-unavailable");
                requireNative();
                String identityId = PolythLinkRust.identityEndpointId(secret);
                if (identityId == null || identityId.isEmpty()) throw new LinkFailure("pairing-storage-failed");
                JSONObject result = invokeObject(
                    "connection.recover",
                    new JSObject().put("connectionId", connectionId),
                    secret
                );
                switch (result.optString("state", "")) {
                    case "connected":
                        result.remove("state");
                        rememberTransport(connectionId, result);
                        call.resolve(new JSObject()
                            .put("state", "connected")
                            .put("launch", JSObject.fromJSONObject(result)));
                        break;
                    case "orphaned":
                        JSONObject metadata = connectionMetadata(connectionId);
                        boolean attemptPending = false;
                        for (PairingSecretRecord attempt : attempts.values()) {
                            if (connectionId.equals(attempt.hostId())) {
                                attemptPending = true;
                                break;
                            }
                        }
                        if (!identityId.equals(result.optString("identityEndpointId", ""))
                            || metadata == null
                            || !"prepared".equals(metadata.optString("pairingState", ""))
                            || attemptPending) {
                            throw new LinkFailure("pairing-confirmation-required");
                        }
                        secureStore.delete(connectionId);
                        invoke("forget", new JSObject().put("connectionId", connectionId), null);
                        forgetTransport(connectionId);
                        call.resolve(new JSObject()
                            .put("state", "needs-pairing")
                            .put("connectionId", connectionId));
                        break;
                    default:
                        throw new LinkFailure("transport-protocol-error");
                }
            } catch (Exception error) { reject(call, error); }
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        if (!trusted(call)) return;
        String connectionId = require(call, "connectionId", "device-unknown");
        if (connectionId == null) return;
        controlExecutor.execute(() -> {
            try {
                invoke("disconnect", new JSObject().put("connectionId", connectionId), null);
                forgetTransport(connectionId);
                call.resolve(new JSObject().put("ok", true));
            } catch (Exception error) { reject(call, error); }
        });
    }

    @PluginMethod
    public void forgetConnection(PluginCall call) {
        if (!trusted(call)) return;
        String connectionId = require(call, "connectionId", "device-unknown");
        if (connectionId == null) return;
        controlExecutor.execute(() -> {
            try {
                invoke("disconnect", new JSObject().put("connectionId", connectionId), null);
                // Native push owns its own capability and must revoke only
                // mappings for this trusted connection before Link erases it.
                PolythPushPlugin.forgetConnection(getContext(), connectionId);
                secureStore.delete(connectionId);
                invoke("forget", new JSObject().put("connectionId", connectionId), null);
                forgetTransport(connectionId);
                call.resolve(new JSObject().put("ok", true));
            } catch (Exception error) { reject(call, error); }
        });
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        if (!trusted(call)) return;
        String connectionId = require(call, "connectionId", "device-unknown");
        if (connectionId == null) return;
        executor.execute(() -> {
            try { call.resolve(JSObject.fromJSONObject(invokeObject("status", new JSObject().put("connectionId", connectionId), null))); }
            catch (Exception error) { reject(call, error); }
        });
    }
}
