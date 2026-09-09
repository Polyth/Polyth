package com.polyth.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "PolythLink")
public final class PolythLinkPlugin extends Plugin {
    private static final String PREFS = "polyth_link_secure";
    private static final String STATE_PREFS = "polyth_link_state";
    private static final String LAST_CONNECTION = "last_connection_id";
    private static final String KEY_PREFIX = "polyth-link-";
    private static final int SECRET_LENGTH = 32;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final ExecutorService controlExecutor = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String, PairingSecretRecord> attempts = new ConcurrentHashMap<>();
    private volatile long clientHandle;

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
        restoreLoopbackTransport();
    }

    @Override
    protected void handleOnDestroy() {
        long handle = clientHandle;
        clientHandle = 0;
        if (handle != 0) PolythLinkRust.clientFree(handle);
        executor.shutdownNow();
        controlExecutor.shutdownNow();
        super.handleOnDestroy();
    }

    private boolean trusted(PluginCall call) {
        try {
            String raw = getBridge().getWebView().getUrl();
            URI url = URI.create(raw == null ? "" : raw);
            if ("https".equalsIgnoreCase(url.getScheme()) && "localhost".equalsIgnoreCase(url.getHost()) && url.getPort() == -1) {
                return true;
            }
        } catch (Exception ignored) {}
        call.reject("forbidden", "forbidden");
        return false;
    }

    private boolean loopbackContent() {
        try {
            String raw = getBridge().getWebView().getUrl();
            URI url = URI.create(raw == null ? "" : raw);
            return "http".equalsIgnoreCase(url.getScheme()) && "127.0.0.1".equals(url.getHost());
        } catch (Exception ignored) {
            return false;
        }
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

    private synchronized long ensureClient() throws LinkFailure {
        if (clientHandle != 0) return clientHandle;
        try {
            File dataDir = new File(getContext().getNoBackupFilesDir(), "polyth-link");
            if (!dataDir.exists() && !dataDir.mkdirs()) throw new LinkFailure("pairing-storage-failed");
            File webDir = prepareWebAssets();
            clientHandle = PolythLinkRust.clientNew(dataDir.getAbsolutePath(), webDir.getAbsolutePath());
            if (clientHandle == 0) throw new LinkFailure("transport-unavailable");
            return clientHandle;
        } catch (LinkFailure error) {
            throw error;
        } catch (Exception error) {
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

    private void discardPrepared(String connectionId) throws Exception {
        invoke("disconnect", new JSObject().put("connectionId", connectionId), null);
        secureStore.delete(connectionId);
        invoke("forget", new JSObject().put("connectionId", connectionId), null);
        forgetTransport(connectionId);
    }

    private void rememberTransport(String connectionId) {
        statePrefs.edit().putString(LAST_CONNECTION, connectionId).apply();
    }

    private void forgetTransport(String connectionId) {
        if (connectionId.equals(statePrefs.getString(LAST_CONNECTION, null))) {
            statePrefs.edit().remove(LAST_CONNECTION).apply();
        }
    }

    private void restoreLoopbackTransport() {
        if (!loopbackContent()) return;
        String connectionId = statePrefs.getString(LAST_CONNECTION, null);
        if (connectionId == null || connectionId.isEmpty()) return;
        controlExecutor.execute(() -> {
            try {
                JSONObject status = invokeObject("status", new JSObject().put("connectionId", connectionId), null);
                if ("connected".equals(status.optString("state", ""))) return;
                byte[] secret = secureStore.load(connectionId);
                if (secret == null) throw new LinkFailure("host-identity-unavailable");
                JSONObject result = invokeObject("connect", new JSObject().put("connectionId", connectionId), secret);
                String bootstrap = result.optString("bootstrapUrl", result.optString("bootstrap", ""));
                if (bootstrap.isEmpty()) throw new LinkFailure("proxy-bootstrap-invalid");
                getActivity().runOnUiThread(() -> {
                    if (loopbackContent()) getBridge().getWebView().loadUrl(bootstrap);
                });
            } catch (Exception error) {
                getActivity().runOnUiThread(() -> {
                    if (loopbackContent()) getBridge().getWebView().loadUrl("https://localhost");
                });
            }
        });
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
                if (!connectionId.isEmpty()) rememberTransport(connectionId);
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
            boolean prepared = false;
            try {
                JSONObject metadata = connectionMetadata(connectionId);
                prepared = metadata != null && "prepared".equals(metadata.optString("pairingState", ""));
                byte[] secret = secureStore.load(connectionId);
                if (secret == null) throw new LinkFailure("host-identity-unavailable");
                JSONObject result = invokeObject("connect", new JSObject().put("connectionId", connectionId), secret);
                rememberTransport(connectionId);
                call.resolve(JSObject.fromJSONObject(result));
            } catch (Exception error) {
                String code = error instanceof LinkFailure ? ((LinkFailure) error).code : "";
                if (prepared && ("pairing-invalid".equals(code) || "device-unknown".equals(code))) {
                    try { discardPrepared(connectionId); } catch (Exception ignored) {}
                }
                reject(call, error);
            }
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
