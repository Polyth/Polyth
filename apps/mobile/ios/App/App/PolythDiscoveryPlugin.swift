import Foundation
import Network
import UIKit
import Capacitor

@objc(PolythDiscoveryPlugin)
final class PolythDiscoveryPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "PolythDiscoveryPlugin"
    let jsName = "PolythDiscovery"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopDiscovery", returnType: CAPPluginReturnPromise),
    ]

    private let queue = DispatchQueue(label: "com.polyth.mobile.discovery", qos: .userInitiated)
    private let lock = NSLock()
    private var browser: NWBrowser?
    private var generation = 0
    private var emptyWork: DispatchWorkItem?

    override public func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appWillResignActive),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        stopInternal()
    }

    private func trusted(_ call: CAPPluginCall) -> Bool {
        guard let url = webView?.url,
              url.scheme?.lowercased() == "capacitor",
              url.host?.lowercased() == "localhost" else {
            call.reject("forbidden", "forbidden")
            return false
        }
        return true
    }

    @objc func startDiscovery(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        stopInternal()

        let current: Int
        let next: NWBrowser
        lock.lock()
        generation += 1
        current = generation
        let parameters = NWParameters.udp
        parameters.includePeerToPeer = true
        next = NWBrowser(
            for: .bonjourWithTXTRecord(type: "_polyth._udp", domain: "local."),
            using: parameters
        )
        browser = next
        lock.unlock()

        next.stateUpdateHandler = { [weak self] state in
            self?.handleState(state, generation: current)
        }
        next.browseResultsChangedHandler = { [weak self] results, _ in
            self?.handleResults(results, generation: current)
        }
        next.start(queue: queue)
        emit(generation: current, state: "discovering", results: [])
        scheduleEmpty(generation: current)
        call.resolve(["ok": true])
    }

    @objc func stopDiscovery(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        stopInternal()
        call.resolve(["ok": true])
    }

    @objc private func appWillResignActive() {
        stopInternal()
    }

    private func handleState(_ state: NWBrowser.State, generation current: Int) {
        guard isCurrent(current) else { return }
        switch state {
        case .ready:
            emit(generation: current, state: "discovering", results: [])
        case .waiting(let error):
            if policyDenied(error) {
                emit(
                    generation: current,
                    state: "permission-required",
                    results: [],
                    error: "discovery-permission-denied"
                )
            }
        case .failed:
            emit(generation: current, state: "error", results: [], error: "discovery-unavailable")
            stopInternalIfCurrent(current)
        case .cancelled, .setup:
            break
        @unknown default:
            break
        }
    }

    private func handleResults(_ raw: Set<NWBrowser.Result>, generation current: Int) {
        guard isCurrent(current) else { return }
        var byEndpoint: [String: [String: Any]] = [:]
        for result in raw {
            guard case let .service(name, _, _, _) = result.endpoint,
                  safe(name, max: 128) != nil,
                  case let .bonjour(txt) = result.metadata else { continue }
            let properties = txt.dictionary
            guard let endpoint = endpoint(properties["endpoint"]),
                  properties["v"] == "1",
                  let label = safe(properties["label"] ?? name, max: 80),
                  let portRaw = properties["port"],
                  let port = Int(portRaw),
                  (1...65535).contains(port) else { continue }
            byEndpoint[endpoint] = [
                "id": endpoint,
                "serviceName": name,
                "hostLabel": label,
                "hostEndpointId": endpoint,
                "protocolVersion": 1,
                "port": port,
                "addresses": [],
                "numericPairing": properties["code"] == "1",
            ]
        }
        let results = byEndpoint.values.sorted {
            (($0["hostLabel"] as? String) ?? "Polyth").localizedCaseInsensitiveCompare(
                ($1["hostLabel"] as? String) ?? "Polyth"
            ) == .orderedAscending
        }
        emit(
            generation: current,
            state: results.isEmpty ? "discovering" : "results",
            results: results
        )
    }

    private func scheduleEmpty(generation current: Int) {
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.isCurrent(current) else { return }
            self.emit(generation: current, state: "empty", results: [])
        }
        lock.lock()
        emptyWork?.cancel()
        emptyWork = work
        lock.unlock()
        queue.asyncAfter(deadline: .now() + 3, execute: work)
    }

    private func emit(
        generation current: Int,
        state: String,
        results: [[String: Any]],
        error: String? = nil
    ) {
        guard isCurrent(current) else { return }
        var payload: [String: Any] = ["state": state, "results": results]
        if let error { payload["error"] = error }
        notifyListeners("discoveryChanged", data: payload)
    }

    private func policyDenied(_ error: NWError) -> Bool {
        if case let .dns(code) = error {
            return Int(code) == -65570
        }
        return false
    }

    private func endpoint(_ value: String?) -> String? {
        guard let value, value.count >= 32, value.count <= 64 else { return nil }
        let allowed = CharacterSet.alphanumerics
        guard value.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        return value
    }

    private func safe(_ value: String?, max: Int) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= max else { return nil }
        guard !trimmed.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }
        return trimmed
    }

    private func isCurrent(_ current: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return generation == current && browser != nil
    }

    private func stopInternalIfCurrent(_ current: Int) {
        lock.lock()
        let shouldStop = generation == current && browser != nil
        lock.unlock()
        if shouldStop { stopInternal() }
    }

    private func stopInternal() {
        let previous: NWBrowser?
        lock.lock()
        generation += 1
        previous = browser
        browser = nil
        emptyWork?.cancel()
        emptyWork = nil
        lock.unlock()
        previous?.cancel()
    }
}
