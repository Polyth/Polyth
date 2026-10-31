import Foundation
#if canImport(ActivityKit)
import ActivityKit

/// The one Live Activity Polyth shows (Dynamic Island + Lock Screen): the chat
/// that most needs a person, or the one that is working. Compiled into both the
/// App target (which starts/updates/ends it) and the PolythLiveActivity widget
/// extension (which renders it), so the two always agree on the shape.
///
/// Every string is already localized and bounded by the web shell
/// (`apps/web/src/liveActivity.ts`) and re-validated by
/// `PolythLiveActivityPlugin`; the extension only lays it out. Content stays on
/// the device: there is no push-token path, so nothing here reaches a relay.
@available(iOS 16.1, *)
struct PolythActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// needs-approval | needs-reply | working | failed | done
        var state: String
        /// Canonical Polyth session id the tap opens (same page only).
        var sessionId: String
        var title: String
        /// The pending question / approval / current task; may be empty.
        var detail: String
        /// Short localized status word ("Reply needed", "Working").
        var label: String
        /// Localized "2 working · 1 waiting" line for other chats; may be empty.
        var summary: String
        /// Localized hint shown once the snapshot is stale (app suspended).
        var staleHint: String
        /// Start of the current work, for the system-drawn elapsed timer.
        var startedAt: Date?
        var done: Int
        var total: Int
    }
}
#endif
