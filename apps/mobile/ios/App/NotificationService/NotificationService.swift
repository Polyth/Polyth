import CryptoKit
import Foundation
import Security
import UserNotifications

/** Opens the sealed push text (docs/mobile/native-push-content.md, "Opening")
 * with the device key the app stored in the shared Keychain group. Every
 * failure, and the extension time limit, delivers the original generic text. */
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        lock.lock()
        self.contentHandler = contentHandler
        self.original = request.content
        lock.unlock()

        let info = request.content.userInfo
        guard let sealed = info["sealed"] as? String, !sealed.isEmpty,
              let subscriptionId = info["subscriptionId"] as? String,
              let text = Self.open(sealed: sealed, subscriptionId: subscriptionId),
              let updated = request.content.mutableCopy() as? UNMutableNotificationContent else {
            deliver(request.content)
            return
        }
        updated.title = text.title
        updated.body = text.body
        deliver(updated)
    }

    override func serviceExtensionTimeWillExpire() {
        lock.lock()
        let content = original
        lock.unlock()
        if let content { deliver(content) }
    }

    /** The handler may run only once, whichever path wins. */
    private func deliver(_ content: UNNotificationContent) {
        lock.lock()
        let handler = contentHandler
        contentHandler = nil
        lock.unlock()
        handler?(content)
    }

    // MARK: - Opening

    private static let contentService = "com.polyth.mobile.native-push.content"
    private static let maxTitle = 120
    private static let maxBody = 400
    private static let pointLength = 65
    private static let headerLength = 86
    private static let tagLength = 16

    private static func accessGroup() -> String? {
        guard let prefix = Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String,
              !prefix.isEmpty, !prefix.contains("$(") else { return nil }
        return prefix + "com.polyth.mobile.push-content"
    }

    /** 32-byte raw P-256 private key followed by the 16-byte auth secret. */
    private static func loadKey(subscriptionId: String) -> (privateKey: Data, auth: Data)? {
        guard let group = accessGroup() else { return nil }
        var output: CFTypeRef?
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: contentService,
            kSecAttrAccount: subscriptionId,
            kSecAttrAccessGroup: group,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        guard SecItemCopyMatching(query as CFDictionary, &output) == errSecSuccess,
              let stored = output as? Data, stored.count == 48 else { return nil }
        let bytes = [UInt8](stored)
        return (Data(bytes[0..<32]), Data(bytes[32..<48]))
    }

    private static func base64URLDecode(_ text: String) -> Data? {
        var value = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = value.count % 4
        if remainder == 1 { return nil }
        if remainder > 0 { value += String(repeating: "=", count: 4 - remainder) }
        return Data(base64Encoded: value)
    }

    private static func hmac(_ key: Data, _ data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    private static func clean(_ value: String, max: Int) -> String {
        let kept = value.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
        return String(String.UnicodeScalarView(kept.prefix(max)))
    }

    /** Contract steps 1-11. Returns nil on any failure. */
    static func open(sealed: String, subscriptionId: String) -> (title: String, body: String)? {
        guard let stored = loadKey(subscriptionId: subscriptionId),
              let message = base64URLDecode(sealed) else { return nil }
        let b = [UInt8](message)
        // 1. Header: salt(16) rs(4) idlen(1) keyid(65) record.
        guard b.count >= headerLength + tagLength + 1 else { return nil }
        let rs = (UInt64(b[16]) << 24) | (UInt64(b[17]) << 16) | (UInt64(b[18]) << 8) | UInt64(b[19])
        guard rs >= 18, Int(b[20]) == pointLength, b[21] == 0x04 else { return nil }
        let salt = Data(b[0..<16])
        let senderPoint = Data(b[21..<headerLength])
        let record = Data(b[headerLength...])
        guard record.count >= tagLength + 1, UInt64(record.count) <= rs else { return nil }

        do {
            // 2. ECDH.
            let privateKey = try P256.KeyAgreement.PrivateKey(rawRepresentation: stored.privateKey)
            let senderKey = try P256.KeyAgreement.PublicKey(x963Representation: senderPoint)
            let shared = try privateKey.sharedSecretFromKeyAgreement(with: senderKey)
            let ecdh = shared.withUnsafeBytes { Data($0) }
            guard ecdh.count == 32 else { return nil }

            // 3-8. Key schedule.
            let prkKey = hmac(stored.auth, ecdh)
            var keyInfo = Data("WebPush: info".utf8)
            keyInfo.append(0)
            keyInfo.append(privateKey.publicKey.x963Representation)
            keyInfo.append(senderPoint)
            keyInfo.append(1)
            let ikm = hmac(prkKey, keyInfo)
            let prk = hmac(salt, ikm)
            var cekInfo = Data("Content-Encoding: aes128gcm".utf8)
            cekInfo.append(contentsOf: [0, 1])
            var nonceInfo = Data("Content-Encoding: nonce".utf8)
            nonceInfo.append(contentsOf: [0, 1])
            let cek = SymmetricKey(data: Data(hmac(prk, cekInfo).prefix(16)))
            let nonce = try AES.GCM.Nonce(data: Data(hmac(prk, nonceInfo).prefix(12)))

            // 9. AES-128-GCM, no additional data.
            let ciphertext = Data(record.prefix(record.count - tagLength))
            let tag = Data(record.suffix(tagLength))
            let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
            var padded = [UInt8](try AES.GCM.open(box, using: cek))

            // 10. Drop trailing zero padding, then the 0x02 delimiter.
            while let last = padded.last, last == 0 { padded.removeLast() }
            guard padded.last == 0x02 else { return nil }
            padded.removeLast()

            // 11. JSON.
            guard let json = try JSONSerialization.jsonObject(with: Data(padded)) as? [String: Any],
                  let version = json["v"] as? NSNumber, version.intValue == 1,
                  let title = json["title"] as? String, let body = json["body"] as? String else { return nil }
            return (clean(title, max: maxTitle), clean(body, max: maxBody))
        } catch {
            return nil
        }
    }
}
