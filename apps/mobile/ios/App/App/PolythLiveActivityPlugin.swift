import Capacitor
import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

/// Starts, updates and ends Polyth's Live Activity (Dynamic Island / Lock
/// Screen) from the shared web shell. The web page publishes while it runs,
/// with a stale date anchored to when the server last confirmed what it shows.
/// Once iOS suspends the app the activity keeps its last snapshot and turns
/// stale at that date (never later than `staleAfter`), so it never claims a
/// live state it no longer knows.
///
/// With push (the page named its account in `setContext` and the build has an
/// APNs environment), the activity is requested with a push token, which goes
/// to the page as a "pushToken" event; the page registers it with its own
/// server over Polyth Link. That server holds the APNs key and pushes the
/// shown chat's state, without words, while the app is suspended; the widget
/// draws the words from `PolythLiveActivityStore`, written here on every
/// update. An activity belongs to one connection/account: another one ends
/// it, so a server the page no longer talks to cannot push into the island.
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
        CAPPluginMethod(name: "setContext", returnType: CAPPluginReturnPromise),
    ]

    /// Latest stale date a page may ask for, and the one used when it names
    /// none (an older page).
    static let staleAfter: TimeInterval = 15 * 60
    /// How long a finished/failed final snapshot stays on the Lock Screen.
    static let finalDismissAfter: TimeInterval = 10 * 60

    private static let states: Set<String> = ["needs-approval", "needs-reply", "working", "failed", "done"]
    private static let sessionPattern = "^[A-Za-z0-9._:-]{1,160}$"

    /// Serial chain: ActivityKit calls are async and a fast burst of updates
    /// must never race into two requested activities.
    private var tail: Task<Void, Never>?

    /// Push state, touched on the main actor only. `accountId` is set by the
    /// page's `setContext` when this build can push.
    private var accountId: String?
    private var latestToken: String?
    private var observed: Set<String> = []
    /// The connection/account whose page started the running activity.
    private static let ownerKey = "polyth-live-activity.owner"

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

    /// The page's `staleAt` (epoch ms; 0 = not confirmed, stale at once),
    /// clamped to now ... now + `staleAfter`.
    private static func staleDate(_ ms: Double?) -> Date {
        let now = Date()
        let latest = now.addingTimeInterval(staleAfter)
        guard let ms, ms.isFinite, ms >= 0 else { return latest }
        return min(max(Date(timeIntervalSince1970: ms / 1000), now), latest)
    }

    private static func lines(_ value: Any?) -> [String] {
        guard let list = value as? [Any] else { return [] }
        return list.prefix(99).map { text($0, max: 80) }
    }

    /// The words a push cannot carry, from the page (`LiveActivityTexts`).
    private static func texts(_ object: [String: Any]?) -> PolythLiveActivityStore.Texts? {
        guard let object, let raw = object["labels"] as? [String: Any] else { return nil }
        var labels: [String: String] = [:]
        for state in states { labels[state] = text(raw[state], max: 48) }
        return PolythLiveActivityStore.Texts(labels: labels, waiting: lines(object["waiting"]), working: lines(object["working"]))
    }

    private static func opaque(_ value: String?) -> String? {
        guard let value, value.range(of: "^[A-Za-z0-9._:-]{1,160}$", options: .regularExpression) != nil else { return nil }
        return value
    }

    /// The last snapshot the widget draws a push from; skipped when unchanged.
    private var stored: PolythLiveActivityStore.Snapshot?

    #if canImport(ActivityKit)
    @available(iOS 16.2, *)
    private func remember(_ state: PolythActivityAttributes.ContentState) {
        let snapshot = PolythLiveActivityStore.Snapshot(
            state: state.state, sessionId: state.sessionId ?? "", title: state.title ?? "", detail: state.detail ?? "",
            staleHint: state.staleHint ?? "", done: state.done ?? 0, total: state.total ?? 0
        )
        guard snapshot != stored else { return }
        stored = snapshot
        PolythLiveActivityStore.write(snapshot, account: "snapshot")
    }

    /// Hands every push token of `activity` to the page, which registers it
    /// with its server. A new process re-observes the activity it finds.
    @available(iOS 16.2, *)
    private func observe(_ activity: Activity<PolythActivityAttributes>) {
        guard accountId != nil, !observed.contains(activity.id) else { return }
        observed.insert(activity.id)
        Task { @MainActor in
            for await data in activity.pushTokenUpdates {
                self.pushToken(data.map { String(format: "%02x", $0) }.joined())
            }
            self.observed.remove(activity.id)
        }
    }
    #endif

    /// Main actor. Hands the activity's push token to the page, which
    /// registers it with its server; retained until a page listens.
    private func pushToken(_ token: String) {
        guard accountId != nil, !token.isEmpty, let environment = PolythPushPlugin.shared.apnsEnvironment() else { return }
        latestToken = token
        notifyListeners("pushToken", data: ["providerToken": token, "environment": environment], retainUntilConsumed: true)
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
            let staleDate = Self.staleDate(call.getDouble("staleAt"))
            enqueue {
                let content = ActivityContent(state: state, staleDate: staleDate)
                self.remember(state)
                let running = Activity<PolythActivityAttributes>.activities
                    .filter { $0.activityState == .active || $0.activityState == .stale }
                if let current = running.first {
                    self.observe(current)
                    // Always applied: the page sends only changed content or a
                    // stale date the server confirmed further.
                    await current.update(content)
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
                    let activity: Activity<PolythActivityAttributes>
                    if self.accountId != nil {
                        // A build without the push entitlement refuses a token; the
                        // activity then simply stays local.
                        do {
                            activity = try Activity<PolythActivityAttributes>.request(attributes: PolythActivityAttributes(), content: content, pushType: .token)
                        } catch {
                            activity = try Activity<PolythActivityAttributes>.request(attributes: PolythActivityAttributes(), content: content, pushType: nil)
                        }
                    } else {
                        activity = try Activity<PolythActivityAttributes>.request(attributes: PolythActivityAttributes(), content: content, pushType: nil)
                    }
                    self.observe(activity)
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

    /// `{accountId?, texts}`, before the page's first update. Resolves
    /// `{push}`: whether the activity takes pushes for this page. An activity
    /// another connection/account started is ended first.
    @objc func setContext(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        if let texts = Self.texts(call.getObject("texts")) { PolythLiveActivityStore.write(texts, account: "texts") }
        let account = Self.opaque(call.getString("accountId"))
        let connection = UserDefaults.standard.string(forKey: "polyth-link.last-connection-id") ?? ""
        enqueue {
            let owner = "\(connection)\u{0}\(account ?? "")"
            if UserDefaults.standard.string(forKey: Self.ownerKey) != owner {
                #if canImport(ActivityKit)
                if #available(iOS 16.2, *) {
                    for activity in Activity<PolythActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
                }
                #endif
                UserDefaults.standard.set(owner, forKey: Self.ownerKey)
                self.latestToken = nil
            }
            guard let account, Self.extensionEmbedded, PolythPushPlugin.shared.apnsEnvironment() != nil else {
                self.accountId = nil
                call.resolve(["push": false])
                return
            }
            self.accountId = account
            call.resolve(["push": true])
            #if canImport(ActivityKit)
            if #available(iOS 16.2, *) {
                for activity in Activity<PolythActivityAttributes>.activities { self.observe(activity) }
            }
            #endif
            // A reloaded page has missed the token this process already saw.
            if let token = self.latestToken { self.pushToken(token) }
        }
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
