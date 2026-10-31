package com.polyth.mobile;

import android.util.Log;

final class PolythLinkRust {
    private static final String TAG = "PolythLinkRust";
    private static final Throwable LOAD_FAILURE;

    static {
        Throwable failure = null;
        try {
            System.loadLibrary("polyth_link_jni");
        } catch (Throwable error) {
            // A missing or ABI-incompatible native core must degrade to the
            // documented unavailable state. Letting UnsatisfiedLinkError escape
            // on a bridge worker thread kills the whole app process instead.
            Log.e(TAG, "Polyth Link native library failed to load", error);
            failure = error;
        }
        LOAD_FAILURE = failure;
    }

    private PolythLinkRust() {}

    static boolean isAvailable() {
        return LOAD_FAILURE == null;
    }

    static native long clientNew(String dataDir, String webDist);
    static native void clientFree(long handle);
    static native String invoke(long handle, String method, String paramsJson, byte[] identitySecret);
    static native byte[] generateIdentitySecret();
    static native String identityEndpointId(byte[] identitySecret);
    static native String ticketHostId(String ticket);
}
