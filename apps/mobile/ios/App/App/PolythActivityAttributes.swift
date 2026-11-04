import Foundation
import Security
#if canImport(ActivityKit)
import ActivityKit

/// The one Live Activity Polyth shows (Dynamic Island + Lock Screen): the chat
/// that most needs a person, or the one that is working. Compiled into both the
/// App target (which starts/updates/ends it) and the PolythLiveActivity widget
/// extension (which renders it), so the two always agree on the shape.
///
/// A local update (the page is running) carries every field, already localized
/// and bounded by the web shell (`apps/web/src/liveActivity.ts`) and
/// re-validated by `PolythLiveActivityPlugin`. A server push through the relay
/// carries only `state`, `startedAt`, `waiting` and `working`: no chat text
/// leaves the host. The widget then draws the words from the copy this device
/// keeps in `PolythLiveActivityStore`. Every other field is therefore optional,
/// or ActivityKit could not decode a push and would drop it.
@available(iOS 16.1, *)
struct PolythActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// needs-approval | needs-reply | working | failed | done
        var state: String
        /// Canonical Polyth session id the tap opens (same page only).
        var sessionId: String?
        var title: String?
        /// The pending question / approval / current task; may be empty.
        var detail: String?
        /// Short localized status word ("Reply needed", "Working").
        var label: String?
        /// Localized "2 working · 1 waiting" line for other chats; may be empty.
        var summary: String?
        /// Localized hint shown once the snapshot is stale (app suspended).
        var staleHint: String?
        /// Start of the current work, for the system-drawn elapsed timer.
        var startedAt: Date?
        var done: Int?
        var total: Int?
        /// Other chats waiting for a person / working (pushes only).
        var waiting: Int?
        var working: Int?
    }
}
#endif

/// The words a pushed update cannot carry, kept by the App for its widget in a
/// Keychain group the two share (`com.polyth.mobile.live-activity`): the last
/// snapshot the page showed and the page's status words and count lines. It
/// stays on this device and is readable after the first unlock, so the Lock
/// Screen can draw it. Nothing else reads it.
enum PolythLiveActivityStore {
    static let service = "com.polyth.mobile.live-activity"
    static let groupSuffix = "com.polyth.mobile.live-activity"

    struct Snapshot: Codable, Equatable {
        var state: String
        var sessionId: String
        var title: String
        var detail: String
        var staleHint: String
        var done: Int
        var total: Int
    }

    struct Texts: Codable, Equatable {
        /// Status word per state.
        var labels: [String: String]
        /// Index n-1: "n other chats waiting" / "working".
        var waiting: [String]
        var working: [String]
    }

    static func read<T: Decodable>(_ type: T.Type, account: String) -> T? {
        // No access group: the search covers every group this target belongs to.
        var output: CFTypeRef?
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account,
            kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne,
        ]
        guard SecItemCopyMatching(query as CFDictionary, &output) == errSecSuccess, let data = output as? Data else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    /// App only: the widget never writes. Nil group (the build did not
    /// substitute the prefix) leaves pushes drawing generic words.
    static func write<T: Encodable>(_ value: T, account: String) {
        guard let prefix = Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String,
              !prefix.isEmpty, !prefix.contains("$("), let data = try? JSONEncoder().encode(value) else { return }
        let base: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account,
            kSecAttrAccessGroup: prefix + groupSuffix,
        ]
        if SecItemUpdate(base as CFDictionary, [kSecValueData: data] as CFDictionary) == errSecItemNotFound {
            var item = base
            item[kSecValueData] = data
            item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(item as CFDictionary, nil)
        }
    }
}
