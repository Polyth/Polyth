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

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        if let url = connectionOptions.urlContexts.first?.url {
            PolythPendingNavigation.shared.remember(url)
        } else if let url = connectionOptions.userActivities.first?.webpageURL {
            PolythPendingNavigation.shared.remember(url)
        }

        let controller = PolythBridgeViewController()
        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = controller
        window?.makeKeyAndVisible()
        controller.loadViewIfNeeded()
        controller.bridge?.registerPluginInstance(PolythNavigationPlugin())

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
