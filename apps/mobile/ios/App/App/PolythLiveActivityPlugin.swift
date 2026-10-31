import Capacitor
import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

/// Starts, updates and ends Polyth's Live Activity (Dynamic Island / Lock
/// Screen) from the shared web shell. Updates are local and foreground-only:
/// the web page publishes while it runs, and once iOS suspends the app the
/// activity keeps its last snapshot and turns stale after `staleAfter`, so it
/// never claims a live state it no longer knows. No push token is requested.
///
/// Only the bundled shell or the page on the current Polyth Link proxy may
/// drive it (same gate as the push semantic reader); any other origin in the
/// WebView is refused, so arbitrary pages cannot write to the Lock Screen.
@objc(PolythLiveActivityPlugin)
final class PolythLiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "PolythLiveActivityPlugin"
    let jsName = "PolythLiveActivity"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
    ]

    static let staleAfter: TimeInterval = 15 * 60
    /// How long a finished/failed final snapshot stays on the Lock Screen.
    static let finalDismissAfter: TimeInterval = 10 * 60

    private static let states: Set<String> = ["needs-approval", "needs-reply", "working", "failed", "done"]
    private static let sessionPattern = "^[A-Za-z0-9._:-]{1,160}$"

    /// Serial chain: ActivityKit calls are async and a fast burst of updates
    /// must never race into two requested activities.
    private var tail: Task<Void, Never>?

    private func trusted(_ call: CAPPluginCall) -> Bool {
        let url = webView?.url
        let bundled = url?.scheme?.lowercased() == "capacitor" && url?.host?.lowercased() == "localhost"
        guard bundled || PolythLinkPlugin.ownsCurrentProxy(url) else {
            call.reject("forbidden", "forbidden")
            return false
        }
        return true
    }

    /// The widget extension is added at build time and may be absent
    /// (POLYTH_IOS_LIVE_ACTIVITY=0 or missing signing files). Without it there
    /// is nothing to render the activity, so report unsupported.
    private static var extensionEmbedded: Bool {
        guard let plugins = Bundle.main.builtInPlugInsURL else { return false }
        return FileManager.default.fileExists(atPath: plugins.appendingPathComponent("PolythLiveActivity.appex").path)
    }

    private func enqueue(_ work: @escaping () async -> Void) {
        let previous = tail
        tail = Task { @MainActor in
            await previous?.value
            await work()
        }
    }

    private static func text(_ value: Any?, max: Int) -> String {
        guard let raw = value as? String else { return "" }
        let cleaned = raw.unicodeScalars
            .map { CharacterSet.controlCharacters.contains($0) ? " " : String($0) }
            .joined()
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.count > max ? String(cleaned.prefix(max - 1)) + "…" : cleaned
    }

    private static func count(_ value: Any?) -> Int {
        guard let number = value as? NSNumber else { return 0 }
        let int = number.intValue
        return int < 0 ? 0 : min(int, 999)
    }

    #if canImport(ActivityKit)
    @available(iOS 16.2, *)
    private static func content(_ object: [String: Any]?) -> PolythActivityAttributes.ContentState? {
        guard let object,
              let state = object["state"] as? String, states.contains(state),
              let sessionId = object["sessionId"] as? String,
              sessionId.range(of: sessionPattern, options: .regularExpression) != nil else { return nil }
        let title = text(object["title"], max: 120)
        guard !title.isEmpty else { return nil }
        var startedAt: Date?
        if let ms = (object["startedAt"] as? NSNumber)?.doubleValue, ms.isFinite {
            let date = Date(timeIntervalSince1970: ms / 1000)
            let now = Date()
            if date <= now.addingTimeInterval(60), date >= now.addingTimeInterval(-7 * 24 * 3600) { startedAt = date }
        }
        let total = count(object["total"])
        return PolythActivityAttributes.ContentState(
            state: state,
            sessionId: sessionId,
            title: title,
            detail: text(object["detail"], max: 240),
            label: text(object["label"], max: 48),
            summary: text(object["summary"], max: 80),
            staleHint: text(object["staleHint"], max: 80),
            startedAt: startedAt,
            done: min(count(object["done"]), total),
            total: total
        )
    }
    #endif

    @objc func getStatus(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        #if canImport(ActivityKit)
        if #available(iOS 16.2, *), Self.extensionEmbedded {
            call.resolve(["supported": true, "enabled": ActivityAuthorizationInfo().areActivitiesEnabled])
            return
        }
        #endif
        call.resolve(["supported": false, "enabled": false])
    }

    @objc func update(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        #if canImport(ActivityKit)
        if #available(iOS 16.2, *), Self.extensionEmbedded {
            guard let state = Self.content(call.getObject("snapshot")) else {
                call.reject("invalid", "invalid")
                return
            }
            enqueue {
                let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(Self.staleAfter))
                let running = Activity<PolythActivityAttributes>.activities
                    .filter { $0.activityState == .active || $0.activityState == .stale }
                if let current = running.first {
                    if current.content.state != state || current.activityState == .stale {
                        await current.update(content)
                    }
                    // A second one can only come from an older process; keep one.
                    for extra in running.dropFirst() { await extra.end(nil, dismissalPolicy: .immediate) }
                    call.resolve(["active": true])
                    return
                }
                guard ActivityAuthorizationInfo().areActivitiesEnabled else {
                    call.resolve(["active": false])
                    return
                }
                do {
                    _ = try Activity<PolythActivityAttributes>.request(
                        attributes: PolythActivityAttributes(),
                        content: content,
                        pushType: nil
                    )
                    call.resolve(["active": true])
                } catch {
                    // Typically: the app is no longer foreground, or the system
                    // activity budget is used up. Not fatal for the web shell.
                    call.resolve(["active": false])
                }
            }
            return
        }
        #endif
        call.resolve(["active": false])
    }

    @objc func end(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        #if canImport(ActivityKit)
        if #available(iOS 16.2, *), Self.extensionEmbedded {
            let finalState = Self.content(call.getObject("final"))
            enqueue {
                for activity in Activity<PolythActivityAttributes>.activities {
                    if let finalState {
                        await activity.end(
                            ActivityContent(state: finalState, staleDate: nil),
                            dismissalPolicy: .after(Date().addingTimeInterval(Self.finalDismissAfter))
                        )
                    } else {
                        await activity.end(nil, dismissalPolicy: .immediate)
                    }
                }
                call.resolve(["active": false])
            }
            return
        }
        #endif
        call.resolve(["active": false])
    }
}
