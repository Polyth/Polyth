import UIKit
import Foundation
import Capacitor

private final class PolythPendingNavigation {
    static let shared = PolythPendingNavigation()

    private let lock = NSLock()
    private var pendingURL: String?

    func remember(_ url: URL?) {
        guard let value = url?.absoluteString, !value.isEmpty else { return }
        lock.lock()
        pendingURL = value
        lock.unlock()
    }

    func consume() -> String? {
        lock.lock()
        defer { lock.unlock() }
        let value = pendingURL
        pendingURL = nil
        return value
    }
}

@objc(PolythNavigationPlugin)
final class PolythNavigationPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "PolythNavigationPlugin"
    let jsName = "PolythNavigation"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "consumePendingUrl", returnType: CAPPluginReturnPromise),
    ]

    private func trusted(_ call: CAPPluginCall) -> Bool {
        guard let url = webView?.url,
              url.scheme?.lowercased() == "capacitor",
              url.host?.lowercased() == "localhost" else {
            call.reject("forbidden", "forbidden")
            return false
        }
        return true
    }

    @objc func consumePendingUrl(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        if let url = PolythPendingNavigation.shared.consume() {
            call.resolve(["url": url])
        } else {
            call.resolve([:])
        }
    }
}

/// Reports how the software keyboard is about to move, so the web shell can
/// carry its composer on the keyboard's real curve. UIKit only publishes a
/// private curve id (7) and a nominal duration; the actual timing comes from
/// replaying that curve on an invisible probe view and reading back the Core
/// Animation it produces (a spring, or a bezier timing function). Carries no
/// user data — geometry and timing only.
@objc(PolythKeyboardMotionPlugin)
final class PolythKeyboardMotionPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "PolythKeyboardMotionPlugin"
    let jsName = "PolythKeyboardMotion"
    let pluginMethods: [CAPPluginMethod] = []

    private let probe = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
    private var probeOffset: CGFloat = 0

    override public func load() {
        // No background: invisible while still a real, animatable view.
        probe.isUserInteractionEnabled = false
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardWillChangeFrame(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func keyboardWillChangeFrame(_ notification: Notification) {
        guard let info = notification.userInfo else { return }
        let duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0
        let curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? 7
        var payload: [String: Any] = [
            "duration": duration * 1000,
            "curve": Int(curve),
            // Wall-clock send time: the web side subtracts it from its own
            // Date.now() to catch up the bridge's delivery delay.
            "sentAt": Date().timeIntervalSince1970 * 1000,
        ]
        if duration > 0 {
            for (key, value) in sampledCurve(duration: duration, curve: curve) {
                payload[key] = value
            }
        }
        notifyListeners("keyboardMotion", data: payload)
    }

    private func sampledCurve(duration: TimeInterval, curve: UInt) -> [String: Any] {
        guard let host = bridge?.viewController?.view else { return [:] }
        if probe.superview !== host {
            host.insertSubview(probe, at: 0)
        }
        probe.layer.removeAllAnimations()
        probeOffset = probeOffset == 0 ? 1 : 0
        let target = probeOffset
        UIView.animate(
            withDuration: duration,
            delay: 0,
            options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState],
            animations: { self.probe.frame.origin.y = target },
            completion: nil
        )
        let animation = probe.layer.animation(forKey: "position")
        probe.layer.removeAllAnimations()
        if let spring = animation as? CASpringAnimation {
            return [
                "spring": [
                    "mass": Double(spring.mass),
                    "stiffness": Double(spring.stiffness),
                    "damping": Double(spring.damping),
                    "initialVelocity": Double(spring.initialVelocity),
                ],
                "animationDuration": spring.duration * 1000,
            ]
        }
        if let basic = animation as? CABasicAnimation, let timing = basic.timingFunction {
            var first: [Float] = [0, 0]
            var second: [Float] = [0, 0]
            timing.getControlPoint(at: 1, values: &first)
            timing.getControlPoint(at: 2, values: &second)
            return [
                "bezier": [first[0], first[1], second[0], second[1]].map { Double($0) },
                "animationDuration": basic.duration * 1000,
            ]
        }
        return [:]
    }
}

final class PolythRootBridgeViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        // The web app owns safe-area spacing. Clear any UIKit/plug-in inset so
        // the WKWebView canvas itself reaches behind the status bar and the
        // selected workspace background can paint there; controls still use
        // CSS --safe-top to stay below the Dynamic Island/notch.
        webView?.scrollView.contentInsetAdjustmentBehavior = .never
        webView?.scrollView.contentInset = .zero
        webView?.scrollView.scrollIndicatorInsets = .zero
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(PolythLinkPlugin())
        bridge?.registerPluginInstance(PolythNavigationPlugin())
        bridge?.registerPluginInstance(PolythKeyboardMotionPlugin())
        bridge?.registerPluginInstance(PolythLiveActivityPlugin())
        bridge?.registerPluginInstance(PolythPushPlugin.shared)
        PolythPushPlugin.shared.installNotificationDelegate()
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        // Scene-based cold launches surface a notification action here rather
        // than reliably through AppDelegate launch options. Receipt alone is
        // still inert; only this user-selected response records an open.
        if let response = connectionOptions.notificationResponse {
            PolythPushPlugin.shared.recordTapped(response.notification.request.content.userInfo)
        }

        if let url = connectionOptions.urlContexts.first?.url {
            PolythPendingNavigation.shared.remember(url)
        } else if let url = connectionOptions.userActivities.first?.webpageURL {
            PolythPendingNavigation.shared.remember(url)
        }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = PolythRootBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        PolythPendingNavigation.shared.remember(URLContexts.first?.url)
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        PolythPendingNavigation.shared.remember(userActivity.webpageURL)
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
