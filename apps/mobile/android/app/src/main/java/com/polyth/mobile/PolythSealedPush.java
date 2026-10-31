package com.polyth.mobile;

import org.json.JSONObject;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECFieldFp;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.EllipticCurve;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Device half of sealed native push content (docs/mobile/native-push-content.md).
 * Plain java.* / javax.* plus org.json for the final JSON step, so the
 * cryptographic part ({@link #openPlaintext}) is JVM-unit-testable.
 */
final class PolythSealedPush {
    static final int MAX_TITLE = 120;
    static final int MAX_BODY = 400;
    private static final int POINT_LENGTH = 65;
    private static final int HEADER_LENGTH = 21 + POINT_LENGTH;
    private static final int TAG_LENGTH = 16;

    private PolythSealedPush() { }

    /** A freshly generated device content key. */
    static final class ContentKey {
        final byte[] pkcs8Private;
        final byte[] publicPoint;
        final byte[] auth;
        ContentKey(byte[] pkcs8Private, byte[] publicPoint, byte[] auth) {
            this.pkcs8Private = pkcs8Private;
            this.publicPoint = publicPoint;
            this.auth = auth;
        }
    }

    static ContentKey generate() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair pair = generator.generateKeyPair();
        byte[] auth = new byte[16];
        new SecureRandom().nextBytes(auth);
        return new ContentKey(
            pair.getPrivate().getEncoded(),
            uncompressed((ECPublicKey) pair.getPublic()),
            auth
        );
    }

    /** 0x04 || X || Y, each coordinate left-padded to 32 bytes. */
    static byte[] uncompressed(ECPublicKey key) {
        ECPoint w = key.getW();
        byte[] out = new byte[POINT_LENGTH];
        out[0] = 0x04;
        System.arraycopy(fixed32(w.getAffineX()), 0, out, 1, 32);
        System.arraycopy(fixed32(w.getAffineY()), 0, out, 33, 32);
        return out;
    }

    private static byte[] fixed32(BigInteger value) {
        byte[] raw = value.toByteArray();
        byte[] out = new byte[32];
        if (raw.length > 32) {
            // A leading sign byte only; anything else is not a P-256 coordinate.
            System.arraycopy(raw, raw.length - 32, out, 0, 32);
        } else {
            System.arraycopy(raw, 0, out, 32 - raw.length, raw.length);
        }
        return out;
    }

    // java.util.Base64 is API 26; minSdk is 24, so the codec is owned here.
    private static final String ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    static String base64Url(byte[] bytes) {
        StringBuilder out = new StringBuilder((bytes.length * 4 + 2) / 3);
        int i = 0;
        for (; i + 2 < bytes.length; i += 3) {
            int n = ((bytes[i] & 0xff) << 16) | ((bytes[i + 1] & 0xff) << 8) | (bytes[i + 2] & 0xff);
            out.append(ALPHABET.charAt(n >> 18)).append(ALPHABET.charAt((n >> 12) & 63))
                .append(ALPHABET.charAt((n >> 6) & 63)).append(ALPHABET.charAt(n & 63));
        }
        if (bytes.length - i == 1) {
            int n = (bytes[i] & 0xff) << 16;
            out.append(ALPHABET.charAt(n >> 18)).append(ALPHABET.charAt((n >> 12) & 63));
        } else if (bytes.length - i == 2) {
            int n = ((bytes[i] & 0xff) << 16) | ((bytes[i + 1] & 0xff) << 8);
            out.append(ALPHABET.charAt(n >> 18)).append(ALPHABET.charAt((n >> 12) & 63))
                .append(ALPHABET.charAt((n >> 6) & 63));
        }
        return out.toString();
    }

    /** Strict unpadded base64url; null for any other character or length. */
    static byte[] base64UrlDecode(String text) {
        if (text == null || text.length() % 4 == 1) return null;
        byte[] out = new byte[text.length() * 3 / 4];
        int acc = 0, bits = 0, o = 0;
        for (int i = 0; i < text.length(); i++) {
            int v = ALPHABET.indexOf(text.charAt(i));
            if (v < 0) return null;
            acc = (acc << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[o++] = (byte) ((acc >> bits) & 0xff);
                acc &= (1 << bits) - 1;
            }
        }
        return o == out.length ? out : Arrays.copyOf(out, o);
    }

    /** Contract steps 1-11. Returns {title, body}, or null on any failure. */
    static String[] open(String sealedB64url, byte[] pkcs8Private, byte[] uaPublic65, byte[] auth16) {
        try {
            byte[] plaintext = openPlaintext(sealedB64url, pkcs8Private, uaPublic65, auth16);
            if (plaintext == null) return null;
            JSONObject json = new JSONObject(new String(plaintext, StandardCharsets.UTF_8));
            if (json.optInt("v", -1) != 1) return null;
            Object title = json.opt("title");
            Object body = json.opt("body");
            if (!(title instanceof String) || !(body instanceof String)) return null;
            return new String[] { clean((String) title, MAX_TITLE), clean((String) body, MAX_BODY) };
        } catch (Exception ignored) {
            return null;
        }
    }

    /** Remove control characters, then cap by code points. */
    static String clean(String value, int max) {
        StringBuilder out = new StringBuilder();
        int count = 0;
        for (int i = 0; i < value.length() && count < max; ) {
            int cp = value.codePointAt(i);
            i += Character.charCount(cp);
            if (Character.isISOControl(cp)) continue;
            out.appendCodePoint(cp);
            count++;
        }
        return out.toString();
    }

    /** Contract steps 1-10: the unpadded JSON bytes, or null on any failure. */
    static byte[] openPlaintext(String sealedB64url, byte[] pkcs8Private, byte[] uaPublic65, byte[] auth16) {
        try {
            if (sealedB64url == null || pkcs8Private == null || uaPublic65 == null || auth16 == null) return null;
            if (uaPublic65.length != POINT_LENGTH || auth16.length != 16) return null;
            byte[] b = base64UrlDecode(sealedB64url);
            if (b == null) return null;

            // 1. Header.
            if (b.length < HEADER_LENGTH + TAG_LENGTH + 1) return null;
            byte[] salt = Arrays.copyOfRange(b, 0, 16);
            long rs = ((b[16] & 0xffL) << 24) | ((b[17] & 0xffL) << 16) | ((b[18] & 0xffL) << 8) | (b[19] & 0xffL);
            int idlen = b[20] & 0xff;
            if (rs < 18 || idlen != POINT_LENGTH) return null;
            byte[] asPublic = Arrays.copyOfRange(b, 21, HEADER_LENGTH);
            if (asPublic[0] != 0x04) return null;
            byte[] record = Arrays.copyOfRange(b, HEADER_LENGTH, b.length);
            if (record.length < TAG_LENGTH + 1 || record.length > rs) return null;

            // 2. ECDH.
            KeyFactory factory = KeyFactory.getInstance("EC");
            PrivateKey privateKey = factory.generatePrivate(new PKCS8EncodedKeySpec(pkcs8Private));
            ECParameterSpec params = ((ECPrivateKey) privateKey).getParams();
            ECPoint point = new ECPoint(
                new BigInteger(1, Arrays.copyOfRange(asPublic, 1, 33)),
                new BigInteger(1, Arrays.copyOfRange(asPublic, 33, 65))
            );
            if (!onCurve(point, params.getCurve())) return null;
            PublicKey senderKey = factory.generatePublic(new ECPublicKeySpec(point, params));
            KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
            agreement.init(privateKey);
            agreement.doPhase(senderKey, true);
            byte[] ecdhSecret = agreement.generateSecret();
            if (ecdhSecret.length != 32) return null;

            // 3-8. Key schedule.
            byte[] prkKey = hmac(auth16, ecdhSecret);
            byte[] keyInfo = concat(ascii("WebPush: info"), new byte[] { 0 }, uaPublic65, asPublic);
            byte[] ikm = hmac(prkKey, concat(keyInfo, new byte[] { 1 }));
            byte[] prk = hmac(salt, ikm);
            byte[] cek = Arrays.copyOf(hmac(prk, concat(ascii("Content-Encoding: aes128gcm"), new byte[] { 0, 1 })), 16);
            byte[] nonce = Arrays.copyOf(hmac(prk, concat(ascii("Content-Encoding: nonce"), new byte[] { 0, 1 })), 12);

            // 9. AES-128-GCM; the JCA expects ciphertext || tag, which is the record.
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, nonce));
            byte[] padded = cipher.doFinal(record);

            // 10. Strip padding delimiter.
            int end = padded.length;
            while (end > 0 && padded[end - 1] == 0) end--;
            if (end == 0 || padded[end - 1] != 0x02) return null;
            return Arrays.copyOf(padded, end - 1);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static boolean onCurve(ECPoint point, EllipticCurve curve) {
        if (!(curve.getField() instanceof ECFieldFp)) return false;
        BigInteger p = ((ECFieldFp) curve.getField()).getP();
        BigInteger x = point.getAffineX();
        BigInteger y = point.getAffineY();
        if (x.signum() < 0 || y.signum() < 0 || x.compareTo(p) >= 0 || y.compareTo(p) >= 0) return false;
        BigInteger left = y.multiply(y).mod(p);
        BigInteger right = x.multiply(x).multiply(x)
            .add(curve.getA().multiply(x)).add(curve.getB()).mod(p);
        return left.equals(right);
    }

    private static byte[] hmac(byte[] key, byte[] data) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data);
    }

    private static byte[] ascii(String value) {
        return value.getBytes(StandardCharsets.US_ASCII);
    }

    private static byte[] concat(byte[]... parts) {
        int length = 0;
        for (byte[] part : parts) length += part.length;
        byte[] out = new byte[length];
        int offset = 0;
        for (byte[] part : parts) {
            System.arraycopy(part, 0, out, offset, part.length);
            offset += part.length;
        }
        return out;
    }
}
