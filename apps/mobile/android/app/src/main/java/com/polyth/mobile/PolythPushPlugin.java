package com.polyth.mobile;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The only Android authority that sees FCM or relay-management credentials.
 * JS can request semantic enable/disable/status/open operations; it has no
 * raw provider-token, relay URL, manage-capability, or filesystem surface.
 */
@CapacitorPlugin(
    name = "PolythPush",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public final class PolythPushPlugin extends Plugin {
    static final String ACTIVITY_CHANNEL = "polyth_activity";
    static final String ATTENTION_CHANNEL = "polyth_attention";
    private static final String STORE = "polyth_native_push_secure";
    private static final String KEY_ALIAS = "polyth-native-push-v1";
    private static final String BINDING_DOMAIN = "polyth-native-push-binding-v1\0";
    private static final String KEY_PENDING = "pending-open";
    private static final String KEY_MAPPING = "mapping/";
    private static final String KEY_SEEN = "seen-notification-ids";
    private static final String KEY_PERMISSION_REQUESTED = "notification-permission-requested";
    private static final int MAX_SEEN = 128;
    private static final int MAX_TAG_LENGTH = 128;
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final AtomicReference<String> FOREGROUND_MAPPING = new AtomicReference<>();
    private static final AtomicReference<String> LATEST_PROVIDER_TOKEN = new AtomicReference<>();
    private final AtomicReference<JSONObject> permissionInput = new AtomicReference<>();

    private SecureStore secure;

    private static final class PushFailure extends Exception {
        PushFailure(String code) { super(code); }
    }

    private static boolean opaque(String value) {
        return value != null && value.matches("[A-Za-z0-9._:-]{1,160}");
    }

    private static boolean subscriptionId(String value) {
        return value != null && value.matches("sub_[A-Za-z0-9_-]{22}");
    }

    private static boolean capability(String value) {
        return value != null && value.matches("[A-Za-z0-9_-]{43}");
    }

    private static boolean tag(String value) {
        return value != null && value.length() <= MAX_TAG_LENGTH && value.matches("[A-Za-z0-9._:-]{1,128}");
    }

    private static boolean notificationId(String value) {
        try { UUID.fromString(value); return true; } catch (Exception ignored) { return false; }
    }

    private static boolean pushKind(String value) {
        return "completed".equals(value) || "failed".equals(value) || "question".equals(value)
            || "permission".equals(value) || "subagent".equals(value);
    }

    private boolean bundled(PluginCall call) {
        try {
            URI url = URI.create(String.valueOf(getBridge().getWebView().getUrl()));
            return "https".equalsIgnoreCase(url.getScheme()) && "localhost".equalsIgnoreCase(url.getHost())
                && url.getPort() == -1;
        } catch (Exception ignored) { return false; }
    }

    /** The exact Polyth Link loopback proxy can invoke only this semantic
     * contract. Raw provider/relay/identity operations are not plugin methods. */
    private boolean semanticReader(PluginCall call) {
        if (bundled(call)) return true;
        return PolythLinkPlugin.ownsCurrentProxy(getContext(), getBridge().getWebView().getUrl());
    }

    private boolean requireBundled(PluginCall call) {
        if (bundled(call)) return true;
        call.reject("forbidden", "forbidden");
        return false;
    }

    private boolean requireSemanticReader(PluginCall call) {
        if (semanticReader(call)) return true;
        call.reject("forbidden", "forbidden");
        return false;
    }

    @Override public void load() {
        secure = new SecureStore(getContext());
        // Current token may have arrived before the plugin was constructed.
        String token = LATEST_PROVIDER_TOKEN.get();
        if (token != null) rotateProviderToken(getContext(), token);
    }

    @PluginMethod public void getStatus(PluginCall call) {
        if (!requireSemanticReader(call)) return;
        JSObject result = new JSObject();
        if (!BuildConfig.POLYTH_FCM_CONFIGURED) {
            result.put("state", "unavailable"); result.put("reason", "firebase-not-configured"); call.resolve(result); return;
        }
        if (!relayOriginValid()) {
            result.put("state", "unavailable"); result.put("reason", "relay-not-configured"); call.resolve(result); return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            // Fresh Android 13+ installs are also DENIED at the framework
            // level. Keep the point-of-use Enable action reachable until the
            // app has actually asked the user once.
            if (permissionRequested(getContext())) {
                result.put("state", "denied"); result.put("reason", "permission-denied");
            } else {
                result.put("state", "disabled");
            }
            call.resolve(result); return;
        }
        try {
            JSONObject mapping = secure.foregroundMapping(FOREGROUND_MAPPING.get());
            if (mapping == null) { result.put("state", "disabled"); }
            else { result.put("state", "enabled"); result.put("subscriptionId", mapping.optString("subscriptionId")); }
        } catch (Exception ignored) {
            result.put("state", "failed"); result.put("reason", "registration-failed");
        }
        call.resolve(result);
    }

    @PluginMethod public void enable(PluginCall call) {
        if (!requireSemanticReader(call)) return;
        if (!BuildConfig.POLYTH_FCM_CONFIGURED) { call.reject("firebase-not-configured", "firebase-not-configured"); return; }
        if (!relayOriginValid()) { call.reject("relay-not-configured", "relay-not-configured"); return; }
        JSONObject input;
        try { input = currentInput(getContext(), call.getString("accountId")); }
        catch (Exception ignored) { call.reject("push-binding-invalid", "push-binding-invalid"); return; }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            if (!permissionInput.compareAndSet(null, input)) { call.reject("push-enabling", "push-enabling"); return; }
            markPermissionRequested(getContext());
            requestPermissionForAlias("notifications", call, "notificationPermissionResult");
            return;
        }
        beginEnable(call, input);
    }

    @PermissionCallback public void notificationPermissionResult(PluginCall call) {
        JSONObject input = permissionInput.getAndSet(null);
        if (getPermissionState("notifications") != PermissionState.GRANTED) {
            call.reject("permission-denied", "permission-denied"); return;
        }
        if (input == null || !semanticReader(call) || !activeInput(getContext(), input)) {
            call.reject("push-binding-invalid", "push-binding-invalid"); return;
        }
        beginEnable(call, input);
    }

    private void beginEnable(PluginCall call, JSONObject input) {
        ensureChannels(getContext());
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null || task.getResult().isEmpty()) {
                call.reject("push-unavailable", "push-unavailable"); return;
            }
            final String providerToken = task.getResult();
            EXECUTOR.execute(() -> {
                try {
                    if (!activeInput(getContext(), input)) throw new PushFailure("push-binding-invalid");
                    JSONObject mapping = register(getContext(), providerToken, input);
                    if (!activeInput(getContext(), input)) {
                        try { relay("DELETE", "/v1/registrations/" + mapping.getString("subscriptionId"), null, mapping.getString("manageToken")); }
                        catch (Exception ignored) { }
                        throw new PushFailure("push-binding-invalid");
                    }
                    JSObject result = new JSObject();
                    result.put("subscriptionId", mapping.getString("subscriptionId"));
                    result.put("claimToken", mapping.getString("claimToken"));
                    result.put("claimExpiresAt", mapping.getLong("claimExpiresAt"));
                    // The claim is intentionally not retained once returned.
                    mapping.remove("claimToken"); mapping.remove("claimExpiresAt");
                    String subscription = mapping.getString("subscriptionId");
                    try {
                        secure.put(KEY_MAPPING + subscription, mapping);
                    } catch (Exception storageFailure) {
                        // Do not orphan a live provider destination when local
                        // secure persistence fails after relay registration.
                        try { relay("DELETE", "/v1/registrations/" + subscription, null, mapping.getString("manageToken")); }
                        catch (Exception ignored) { }
                        throw storageFailure;
                    }
                    // Explicit re-enable replaces this connection/account's
                    // prior destination instead of accumulating stale senders.
                    for (JSONObject prior : secure.mappings()) {
                        if (subscription.equals(prior.optString("subscriptionId"))
                            || !mapping.getString("connectionId").equals(prior.optString("connectionId"))
                            || !mapping.getString("accountId").equals(prior.optString("accountId"))) continue;
                        try { relay("DELETE", "/v1/registrations/" + prior.getString("subscriptionId"), null, prior.getString("manageToken")); }
                        catch (Exception ignored) { }
                        secure.remove(KEY_MAPPING + prior.getString("subscriptionId"));
                    }
                    call.resolve(result);
                } catch (Exception ignored) { call.reject("push-registration-failed", "push-registration-failed"); }
            });
        });
    }

    @PluginMethod public void disable(PluginCall call) {
        if (!requireSemanticReader(call)) return;
        String accountId = call.getString("accountId");
        if (!opaque(accountId)) { call.reject("push-binding-invalid", "push-binding-invalid"); return; }
        JSONObject input;
        try { input = currentInput(getContext(), accountId); }
        catch (Exception ignored) { call.reject("push-disable-failed", "push-disable-failed"); return; }
        EXECUTOR.execute(() -> {
            try {
                if (!activeInput(getContext(), input)) throw new PushFailure("push-binding-invalid");
                JSONObject mapping = secure.currentMapping(input);
                if (mapping != null) {
                    try { relay("DELETE", "/v1/registrations/" + mapping.getString("subscriptionId"), null, mapping.getString("manageToken")); }
                    catch (Exception ignored) { /* Offline delete is best effort; mapping is still forgotten locally. */ }
                    secure.remove(KEY_MAPPING + mapping.getString("subscriptionId"));
                }
                call.resolve(new JSObject().put("ok", true));
            } catch (Exception ignored) { call.reject("push-disable-failed", "push-disable-failed"); }
        });
    }

    @PluginMethod public void consumePendingOpen(PluginCall call) {
        // Only the bundled Connection Hub may consume cross-server routing.
        // Loopback server content can manage its own semantic push state, but
        // cannot race the hub and discard or inspect another server's tap.
        if (!requireBundled(call)) return;
        try {
            JSONObject pending = secure.take(KEY_PENDING);
            JSObject result = new JSObject();
            if (pending != null) {
                result.put("connectionId", pending.optString("connectionId"));
                result.put("accountId", pending.optString("accountId"));
                result.put("notificationId", pending.optString("notificationId"));
            }
            call.resolve(result);
        } catch (Exception ignored) { call.resolve(new JSObject()); }
    }

    @PluginMethod public void setForeground(PluginCall call) {
        if (!requireSemanticReader(call)) return;
        String accountId = call.getString("accountId");
        if (!opaque(accountId)) { call.reject("push-binding-invalid", "push-binding-invalid"); return; }
        JSONObject input;
        try { input = currentInput(getContext(), accountId); }
        catch (Exception ignored) { call.reject("host-identity-unavailable", "host-identity-unavailable"); return; }
        EXECUTOR.execute(() -> {
            try {
                if (!activeInput(getContext(), input)) throw new PushFailure("host-identity-unavailable");
                String key = input.getString("connectionId") + "\0" + accountId;
                if (call.getBoolean("active", false)) FOREGROUND_MAPPING.set(key);
                else FOREGROUND_MAPPING.compareAndSet(key, null);
                call.resolve();
            } catch (Exception ignored) { call.reject("host-identity-unavailable", "host-identity-unavailable"); }
        });
    }

    /** Pull identities from the saved Polyth Link secret, never caller input.
     * `connectionId` is the pinned host endpoint id in the Link contract. */
    private static JSONObject currentInput(Context context, String accountId) throws Exception {
        String connectionId = context.getSharedPreferences("polyth_link_state", Context.MODE_PRIVATE).getString("last_connection_id", null);
        if (!opaque(connectionId) || !opaque(accountId)) throw new PushFailure("host-identity-unavailable");
        byte[] secret = LinkIdentityStore.load(context, connectionId);
        if (secret == null) throw new PushFailure("host-identity-unavailable");
        try {
            String deviceId = PolythLinkRust.identityEndpointId(secret);
            if (!opaque(deviceId)) throw new PushFailure("host-identity-unavailable");
            return new JSONObject().put("connectionId", connectionId).put("hostEndpointId", connectionId).put("deviceEndpointId", deviceId).put("accountId", accountId);
        } finally { java.util.Arrays.fill(secret, (byte) 0); }
    }

    private static boolean activeInput(Context context, JSONObject input) {
        return input.optString("connectionId").equals(
            context.getSharedPreferences("polyth_link_state", Context.MODE_PRIVATE).getString("last_connection_id", null)
        );
    }

    private static JSONObject register(Context context, String providerToken, JSONObject input) throws Exception {
        String binding = binding(input.getString("hostEndpointId"), input.getString("deviceEndpointId"), input.getString("accountId"));
        JSONObject body = new JSONObject().put("platform", "android").put("providerToken", providerToken).put("binding", binding);
        JSONObject response = relay("POST", "/v1/registrations", body, null);
        String subscription = response.optString("subscriptionId");
        String manage = response.optString("manageToken");
        String claim = response.optString("claimToken");
        long expires = response.optLong("claimExpiresAt", 0);
        if (!subscriptionId(subscription) || !capability(manage) || !capability(claim) || expires <= System.currentTimeMillis()) throw new PushFailure("push-registration-failed");
        return input.put("subscriptionId", subscription).put("manageToken", manage).put("claimToken", claim).put("claimExpiresAt", expires).put("binding", binding);
    }

    static void onProviderToken(Context context, String providerToken) {
        if (providerToken == null || providerToken.isEmpty()) return;
        LATEST_PROVIDER_TOKEN.set(providerToken);
        rotateProviderToken(context, providerToken);
    }

    private static void rotateProviderToken(Context context, String providerToken) {
        EXECUTOR.execute(() -> {
            try {
                SecureStore store = new SecureStore(context);
                for (JSONObject mapping : store.mappings()) {
                    // The relay deliberately accepts only a rotated provider token here.
                    JSONObject body = new JSONObject().put("providerToken", providerToken);
                    try { relay("PUT", "/v1/registrations/" + mapping.getString("subscriptionId"), body, mapping.getString("manageToken")); }
                    catch (Exception ignored) { /* A later token refresh retries; no token is logged. */ }
                }
            } catch (Exception ignored) { }
        });
    }

    static void receiveMessage(Context context, Map<String, String> data) {
        try {
            if (!"1".equals(data.get("version")) || !subscriptionId(data.get("subscriptionId"))
                || !notificationId(data.get("notificationId")) || !pushKind(data.get("kind")) || !tag(data.get("tag"))) return;
            SecureStore store = new SecureStore(context);
            JSONObject mapping = store.get(KEY_MAPPING + data.get("subscriptionId"));
            if (mapping == null) return;
            // Receipt is not an open. The only durable navigation state is
            // written by recordTap after a user taps the system notification.
            if ((mapping.getString("connectionId") + "\0" + mapping.getString("accountId")).equals(FOREGROUND_MAPPING.get())) return;
            ensureChannels(context);
            String channel = ("failed".equals(data.get("kind")) || "question".equals(data.get("kind")) || "permission".equals(data.get("kind"))) ? ATTENTION_CHANNEL : ACTIVITY_CHANNEL;
            String title = "Polyth";
            String body;
            switch (data.get("kind")) {
                case "completed": body = "A task completed"; break;
                case "failed": body = "A task needs attention"; break;
                case "question": body = "A task has a question"; break;
                case "permission": body = "A task needs permission"; break;
                default: body = "A delegated task changed";
            }
            android.content.Intent intent = new android.content.Intent(context, MainActivity.class)
                .putExtra("polyth.nativePushOpen", true)
                .putExtra("polyth.nativePush.version", "1")
                .putExtra("polyth.nativePush.subscriptionId", data.get("subscriptionId"))
                .putExtra("polyth.nativePush.notificationId", data.get("notificationId"))
                .putExtra("polyth.nativePush.kind", data.get("kind"))
                .putExtra("polyth.nativePush.tag", data.get("tag"))
                .addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP | android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP);
            android.app.PendingIntent tap = android.app.PendingIntent.getActivity(context, data.get("notificationId").hashCode(), intent, android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            manager.notify(data.get("tag"), data.get("notificationId").hashCode(), new NotificationCompat.Builder(context, channel)
                .setSmallIcon(com.polyth.mobile.R.drawable.ic_stat_polyth).setContentTitle(title).setContentText(body).setAutoCancel(true).setContentIntent(tap).build());
        } catch (Exception ignored) { }
    }

    /** Validated local notification tap (or the matching FCM tray extras).
     * Provider receipt alone never writes KEY_PENDING. */
    static boolean recordTap(Context context, android.content.Intent intent) {
        try {
            String prefix = intent.getBooleanExtra("polyth.nativePushOpen", false) ? "polyth.nativePush." : "";
            String version = intent.getStringExtra(prefix + "version");
            String subscription = intent.getStringExtra(prefix + "subscriptionId");
            String id = intent.getStringExtra(prefix + "notificationId");
            String kind = intent.getStringExtra(prefix + "kind");
            String payloadTag = intent.getStringExtra(prefix + "tag");
            if (!"1".equals(version) || !subscriptionId(subscription) || !notificationId(id) || !pushKind(kind) || !tag(payloadTag)) return false;
            SecureStore store = new SecureStore(context);
            JSONObject mapping = store.get(KEY_MAPPING + subscription);
            if (mapping == null || seen(context, id)) return false;
            store.put(KEY_PENDING, new JSONObject()
                .put("connectionId", mapping.getString("connectionId"))
                .put("accountId", mapping.getString("accountId"))
                .put("notificationId", id.toLowerCase(java.util.Locale.ROOT)));
            return true;
        } catch (Exception ignored) { return false; }
    }

    /** Called by the native Link forget path, before its identity is erased.
     * It never visits mappings for any other saved connection. */
    static void forgetConnection(Context context, String connectionId) {
        if (!opaque(connectionId)) return;
        EXECUTOR.execute(() -> {
            try {
                SecureStore store = new SecureStore(context);
                for (JSONObject mapping : store.mappings()) {
                    if (!connectionId.equals(mapping.optString("connectionId"))) continue;
                    try { relay("DELETE", "/v1/registrations/" + mapping.getString("subscriptionId"), null, mapping.getString("manageToken")); }
                    catch (Exception ignored) { /* Local forget remains authoritative for this install. */ }
                    store.remove(KEY_MAPPING + mapping.getString("subscriptionId"));
                    FOREGROUND_MAPPING.compareAndSet(connectionId + "\0" + mapping.optString("accountId"), null);
                }
                JSONObject pending = store.get(KEY_PENDING);
                if (pending != null && connectionId.equals(pending.optString("connectionId"))) store.remove(KEY_PENDING);
            } catch (Exception ignored) { }
        });
    }

    private static boolean seen(Context context, String id) {
        SharedPreferences prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE);
        LinkedHashSet<String> ids = new LinkedHashSet<>(prefs.getStringSet(KEY_SEEN, java.util.Collections.emptySet()));
        if (!ids.add(id)) return true;
        while (ids.size() > MAX_SEEN) ids.remove(ids.iterator().next());
        prefs.edit().putStringSet(KEY_SEEN, ids).apply();
        return false;
    }

    private static boolean permissionRequested(Context context) {
        return context.getSharedPreferences(STORE, Context.MODE_PRIVATE).getBoolean(KEY_PERMISSION_REQUESTED, false);
    }

    private static void markPermissionRequested(Context context) {
        context.getSharedPreferences(STORE, Context.MODE_PRIVATE).edit().putBoolean(KEY_PERMISSION_REQUESTED, true).apply();
    }

    static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(ACTIVITY_CHANNEL, "Polyth activity", NotificationManager.IMPORTANCE_DEFAULT));
        manager.createNotificationChannel(new NotificationChannel(ATTENTION_CHANNEL, "Polyth needs attention", NotificationManager.IMPORTANCE_HIGH));
    }

    private static String binding(String host, String device, String account) throws Exception {
        byte[] tuple = (BINDING_DOMAIN + host + "\0" + device + "\0" + account).getBytes(StandardCharsets.UTF_8);
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(tuple);
        return Base64.encodeToString(digest, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING)
            .toLowerCase(java.util.Locale.ROOT);
    }

    private static boolean relayOriginValid() {
        try {
            URI uri = URI.create(BuildConfig.POLYTH_PUSH_RELAY_ORIGIN);
            boolean root = (uri.getRawPath() == null || uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath()))
                && uri.getRawUserInfo() == null && uri.getRawQuery() == null && uri.getRawFragment() == null;
            if (!root || uri.getHost() == null) return false;
            if ("https".equalsIgnoreCase(uri.getScheme())) return true;
            return BuildConfig.DEBUG && "http".equalsIgnoreCase(uri.getScheme()) && ("127.0.0.1".equals(uri.getHost()) || "localhost".equals(uri.getHost()));
        } catch (Exception ignored) { return false; }
    }

    private static JSONObject relay(String method, String path, JSONObject body, String manageToken) throws Exception {
        if (!relayOriginValid()) throw new PushFailure("relay-not-configured");
        URL url = URI.create(BuildConfig.POLYTH_PUSH_RELAY_ORIGIN).resolve(path).toURL();
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(8_000); connection.setReadTimeout(8_000); connection.setRequestMethod(method);
        connection.setRequestProperty("Accept", "application/json");
        if (manageToken != null) connection.setRequestProperty("Authorization", "Bearer " + manageToken);
        if (body != null) {
            connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json");
            try (OutputStream output = connection.getOutputStream()) { output.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
        }
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) throw new PushFailure("relay-request-failed");
        if ("DELETE".equals(method)) return new JSONObject();
        StringBuilder raw = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new java.io.InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = reader.readLine()) != null;) raw.append(line);
        }
        return new JSONObject(raw.toString());
    }

    /** Small Keystore-backed record store; regular web storage never sees it. */
    private static final class SecureStore {
        private final SharedPreferences prefs;
        SecureStore(Context context) { prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE); }
        private SecretKey key() throws Exception {
            KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
            if (keys.containsAlias(KEY_ALIAS)) return (SecretKey) keys.getKey(KEY_ALIAS, null);
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            return generator.generateKey();
        }
        void put(String name, JSONObject value) throws Exception {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
            cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV(); byte[] encrypted = cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));
            byte[] packed = new byte[1 + iv.length + encrypted.length]; packed[0] = (byte) iv.length;
            System.arraycopy(iv, 0, packed, 1, iv.length); System.arraycopy(encrypted, 0, packed, 1 + iv.length, encrypted.length);
            if (!prefs.edit().putString(name, android.util.Base64.encodeToString(packed, android.util.Base64.NO_WRAP)).commit()) {
                throw new PushFailure("push-storage-failed");
            }
        }
        JSONObject get(String name) throws Exception {
            String raw = prefs.getString(name, null); if (raw == null) return null;
            byte[] packed = android.util.Base64.decode(raw, android.util.Base64.NO_WRAP); int ivLength = packed[0] & 0xff;
            if (ivLength < 12 || packed.length <= 1 + ivLength) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, java.util.Arrays.copyOfRange(packed, 1, 1 + ivLength)));
            cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
            return new JSONObject(new String(cipher.doFinal(java.util.Arrays.copyOfRange(packed, 1 + ivLength, packed.length)), StandardCharsets.UTF_8));
        }
        JSONObject take(String name) throws Exception { JSONObject value = get(name); remove(name); return value; }
        void remove(String name) { prefs.edit().remove(name).apply(); }
        List<JSONObject> mappings() throws Exception {
            List<JSONObject> result = new ArrayList<>(); for (String name : prefs.getAll().keySet()) if (name.startsWith(KEY_MAPPING)) { JSONObject item = get(name); if (item != null) result.add(item); } return result;
        }
        JSONObject foregroundMapping(String key) throws Exception {
            if (key == null) return null;
            for (JSONObject item : mappings()) if ((item.optString("connectionId") + "\0" + item.optString("accountId")).equals(key)) return item;
            return null;
        }
        JSONObject currentMapping(JSONObject current) throws Exception {
            for (JSONObject item : mappings()) if (item.getString("connectionId").equals(current.getString("connectionId"))
                && item.getString("accountId").equals(current.getString("accountId"))) return item;
            return null;
        }
    }

    /** Reads the existing Polyth Link Keystore record. This is deliberately
     * local to native code; the decrypted endpoint secret is immediately zeroed. */
    private static final class LinkIdentityStore {
        private static final String PREFS = "polyth_link_secure";
        private static final String PREFIX = "polyth-link-";
        static byte[] load(Context context, String hostId) throws Exception {
            String encoded = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(hostId, null);
            if (encoded == null) return null;
            byte[] packed = android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP);
            try {
                if (packed.length < 2) return null;
                int ivLength = packed[0] & 0xff;
                if (ivLength < 12 || packed.length <= 1 + ivLength) return null;
                String alias = PREFIX + android.util.Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(hostId.getBytes(StandardCharsets.UTF_8)), android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
                KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
                SecretKey key = (SecretKey) keys.getKey(alias, null);
                if (key == null) return null;
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, java.util.Arrays.copyOfRange(packed, 1, 1 + ivLength)));
                return cipher.doFinal(java.util.Arrays.copyOfRange(packed, 1 + ivLength, packed.length));
            } finally { java.util.Arrays.fill(packed, (byte) 0); }
        }
    }
}
