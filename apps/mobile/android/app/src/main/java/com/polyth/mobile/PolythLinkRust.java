package com.polyth.mobile;

final class PolythLinkRust {
    static {
        System.loadLibrary("polyth_link_jni");
    }

    private PolythLinkRust() {}

    static native long clientNew(String dataDir, String webDist);
    static native void clientFree(long handle);
    static native String invoke(long handle, String method, String paramsJson, byte[] identitySecret);
    static native byte[] generateIdentitySecret();
    static native String ticketHostId(String ticket);
}
