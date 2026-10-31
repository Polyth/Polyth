package com.polyth.mobile;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import org.junit.Test;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPrivateKeySpec;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** RFC 8291 Appendix A known-answer vector plus malformed-input cases.
 * Only openPlaintext is exercised: org.json is the Android stub on a plain JVM. */
public class PolythSealedPushTest {
    private static final String UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
    private static final String UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    private static final String AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
    private static final String AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    private static final String SALT = "DGv6ra1nlYgDCS1FRnbzlw";
    private static final String MESSAGE = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
    private static final String PLAINTEXT = "When I grow up, I want to be a watermelon";

    private static byte[] b64(String text) {
        byte[] out = PolythSealedPush.base64UrlDecode(text);
        assertNotNull(out);
        return out;
    }

    private static ECParameterSpec p256() throws Exception {
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        return parameters.getParameterSpec(ECParameterSpec.class);
    }

    private static PrivateKey privateKey(byte[] scalar) throws Exception {
        return KeyFactory.getInstance("EC")
            .generatePrivate(new ECPrivateKeySpec(new BigInteger(1, scalar), p256()));
    }

    private static byte[] uaPkcs8() throws Exception {
        return privateKey(b64(UA_PRIVATE)).getEncoded();
    }

    private static byte[] open(String message) throws Exception {
        return PolythSealedPush.openPlaintext(message, uaPkcs8(), b64(UA_PUBLIC), b64(AUTH));
    }

    private static byte[] hmac(byte[] key, byte[] data) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data);
    }

    private static byte[] cat(byte[]... parts) {
        int n = 0;
        for (byte[] part : parts) n += part.length;
        byte[] out = new byte[n];
        int o = 0;
        for (byte[] part : parts) {
            System.arraycopy(part, 0, out, o, part.length);
            o += part.length;
        }
        return out;
    }

    /** Seals `padded` (already carrying whatever delimiter/padding the test wants)
     * with the vector's keys, sender side of RFC 8291. */
    private static String seal(byte[] padded) throws Exception {
        byte[] vector = b64(MESSAGE);
        byte[] asPublic = Arrays.copyOfRange(vector, 21, 86);
        byte[] uaPublic = b64(UA_PUBLIC);
        byte[] salt = b64(SALT);
        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(privateKey(b64(AS_PRIVATE)));
        // The recipient's public key is only needed as a point; reuse the opener's parser path
        // by deriving the shared secret from the recipient key pair instead.
        java.security.spec.ECPoint point = new java.security.spec.ECPoint(
            new BigInteger(1, Arrays.copyOfRange(uaPublic, 1, 33)),
            new BigInteger(1, Arrays.copyOfRange(uaPublic, 33, 65)));
        agreement.doPhase(KeyFactory.getInstance("EC")
            .generatePublic(new java.security.spec.ECPublicKeySpec(point, p256())), true);
        byte[] secret = agreement.generateSecret();
        byte[] prkKey = hmac(b64(AUTH), secret);
        byte[] keyInfo = cat("WebPush: info".getBytes(StandardCharsets.US_ASCII), new byte[] { 0 }, uaPublic, asPublic);
        byte[] ikm = hmac(prkKey, cat(keyInfo, new byte[] { 1 }));
        byte[] prk = hmac(salt, ikm);
        byte[] cek = Arrays.copyOf(hmac(prk, cat("Content-Encoding: aes128gcm".getBytes(StandardCharsets.US_ASCII), new byte[] { 0, 1 })), 16);
        byte[] nonce = Arrays.copyOf(hmac(prk, cat("Content-Encoding: nonce".getBytes(StandardCharsets.US_ASCII), new byte[] { 0, 1 })), 12);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, nonce));
        byte[] record = cipher.doFinal(padded);
        return PolythSealedPush.base64Url(cat(Arrays.copyOfRange(vector, 0, 86), record));
    }

    @Test public void codecRoundTrips() {
        for (int length = 0; length < 10; length++) {
            byte[] data = new byte[length];
            for (int i = 0; i < length; i++) data[i] = (byte) (i * 37 + 250);
            assertArrayEquals(data, PolythSealedPush.base64UrlDecode(PolythSealedPush.base64Url(data)));
        }
        assertNull(PolythSealedPush.base64UrlDecode("a+b/"));
        assertNull(PolythSealedPush.base64UrlDecode("abcde"));
    }

    @Test public void opensTheRfcVector() throws Exception {
        assertEquals(PLAINTEXT, new String(open(MESSAGE), StandardCharsets.UTF_8));
    }

    @Test public void ourSealMatchesTheVectorBytes() throws Exception {
        assertEquals(MESSAGE, seal((PLAINTEXT + "\u0002").getBytes(StandardCharsets.UTF_8)));
    }

    @Test public void stripsTrailingZeroPadding() throws Exception {
        byte[] padded = cat("hi".getBytes(StandardCharsets.UTF_8), new byte[] { 2, 0, 0, 0 });
        assertEquals("hi", new String(open(seal(padded)), StandardCharsets.UTF_8));
    }

    @Test public void rejectsWrongDelimiter() throws Exception {
        assertNull(open(seal(cat("hi".getBytes(StandardCharsets.UTF_8), new byte[] { 1 }))));
        assertNull(open(seal("hi".getBytes(StandardCharsets.UTF_8))));
        assertNull(open(seal(new byte[] { 0, 0 })));
    }

    @Test public void rejectsTamperedCiphertext() throws Exception {
        byte[] bytes = b64(MESSAGE);
        bytes[bytes.length - 20] ^= 0x01;
        assertNull(open(PolythSealedPush.base64Url(bytes)));
    }

    @Test public void rejectsTamperedTag() throws Exception {
        byte[] bytes = b64(MESSAGE);
        bytes[bytes.length - 1] ^= 0x01;
        assertNull(open(PolythSealedPush.base64Url(bytes)));
    }

    @Test public void rejectsTamperedHeader() throws Exception {
        byte[] salt = b64(MESSAGE);
        salt[0] ^= 0x01;
        assertNull(open(PolythSealedPush.base64Url(salt)));
        byte[] idlen = b64(MESSAGE);
        idlen[20] = 64;
        assertNull(open(PolythSealedPush.base64Url(idlen)));
        byte[] prefix = b64(MESSAGE);
        prefix[21] = 0x02;
        assertNull(open(PolythSealedPush.base64Url(prefix)));
        byte[] rs = b64(MESSAGE);
        rs[16] = 0; rs[17] = 0; rs[18] = 0; rs[19] = 20; // record is longer than rs
        assertNull(open(PolythSealedPush.base64Url(rs)));
    }

    @Test public void rejectsOffCurveSenderPoint() throws Exception {
        byte[] bytes = b64(MESSAGE);
        bytes[85] ^= 0x01; // last byte of Y
        assertNull(open(PolythSealedPush.base64Url(bytes)));
    }

    @Test public void rejectsShortAndGarbageInput() throws Exception {
        assertNull(open(""));
        assertNull(open(MESSAGE.substring(0, 100)));
        assertNull(open("not base64url!"));
        assertNull(PolythSealedPush.openPlaintext(null, uaPkcs8(), b64(UA_PUBLIC), b64(AUTH)));
    }

    @Test public void rejectsWrongKeyOrAuth() throws Exception {
        byte[] wrongAuth = b64(AUTH);
        wrongAuth[0] ^= 0x01;
        assertNull(PolythSealedPush.openPlaintext(MESSAGE, uaPkcs8(), b64(UA_PUBLIC), wrongAuth));
        assertNull(PolythSealedPush.openPlaintext(MESSAGE, uaPkcs8(), Arrays.copyOf(b64(UA_PUBLIC), 64), b64(AUTH)));
        assertNull(PolythSealedPush.openPlaintext(MESSAGE, new byte[] { 1, 2, 3 }, b64(UA_PUBLIC), b64(AUTH)));
    }

    @Test public void cleanRemovesControlsAndCaps() {
        assertEquals("ab", PolythSealedPush.clean("a\u0000\nb\u0007", 10));
        assertEquals("abc", PolythSealedPush.clean("abcdef", 3));
    }

    @Test public void generatedKeyHasContractShape() throws Exception {
        PolythSealedPush.ContentKey key = PolythSealedPush.generate();
        assertEquals(65, key.publicPoint.length);
        assertEquals(0x04, key.publicPoint[0]);
        assertEquals(16, key.auth.length);
        assertEquals(87, PolythSealedPush.base64Url(key.publicPoint).length());
        assertEquals(22, PolythSealedPush.base64Url(key.auth).length());
    }
}
