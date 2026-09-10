import UIKit
import Foundation
import Security
import AVFoundation
import Capacitor
import UserNotifications
import CryptoKit

@_silgen_name("polyth_link_client_new")
private func polythLinkClientNew(_ dataDir: UnsafePointer<CChar>, _ webDist: UnsafePointer<CChar>?) -> UInt64
@_silgen_name("polyth_link_client_free")
private func polythLinkClientFree(_ handle: UInt64)
@_silgen_name("polyth_link_invoke")
private func polythLinkInvoke(_ handle: UInt64, _ method: UnsafePointer<CChar>, _ paramsJSON: UnsafePointer<CChar>, _ identitySecret: UnsafePointer<UInt8>?, _ identitySecretLength: Int) -> UnsafeMutablePointer<CChar>?
@_silgen_name("polyth_link_generate_identity_secret")
private func polythLinkGenerateIdentitySecret(_ output: UnsafeMutablePointer<UInt8>, _ outputLength: Int) -> Int
@_silgen_name("polyth_link_identity_endpoint_id")
private func polythLinkIdentityEndpointID(_ secret: UnsafePointer<UInt8>, _ secretLength: Int) -> UnsafeMutablePointer<CChar>?
@_silgen_name("polyth_link_ticket_host_id")
private func polythLinkTicketHostID(_ ticket: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
@_silgen_name("polyth_link_string_free")
private func polythLinkStringFree(_ value: UnsafeMutablePointer<CChar>)

private struct PolythLinkFailure: Error {
    let code: String
}

private final class PolythLinkKeychain {
    private let service = "com.polyth.mobile.polyth-link.identity"

    func load(_ hostID: String) throws -> Data? {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: hostID,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ] as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, data.count == 32 else {
            throw PolythLinkFailure(code: "pairing-storage-failed")
        }
        return data
    }

    func store(_ secret: Data, for hostID: String) throws {
        guard secret.count == 32 else { throw PolythLinkFailure(code: "pairing-storage-failed") }
        let status = SecItemAdd([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: hostID,
            kSecValueData: secret,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ] as CFDictionary, nil)
        guard status == errSecSuccess else { throw PolythLinkFailure(code: "pairing-storage-failed") }
    }

    func delete(_ hostID: String) throws {
        let status = SecItemDelete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: hostID,
        ] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw PolythLinkFailure(code: "pairing-storage-failed")
        }
    }

    func hostIDs() throws -> Set<String> {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecReturnAttributes: true,
            kSecMatchLimit: kSecMatchLimitAll,
        ] as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { throw PolythLinkFailure(code: "pairing-storage-failed") }
        let rows = result as? [[String: Any]] ?? []
        return Set(rows.compactMap { $0[kSecAttrAccount as String] as? String })
    }
}

private struct PairingSecretRecord {
    let hostID: String
    let createdForAttempt: Bool
}

private final class PolythQRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "com.polyth.mobile.polyth-link.camera")
    private let completion: (Result<String?, PolythLinkFailure>) -> Void
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var finished = false

    init(completion: @escaping (Result<String?, PolythLinkFailure>) -> Void) {
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        do {
            try configureCamera()
        } catch let error as PolythLinkFailure {
            DispatchQueue.main.async { self.finish(.failure(error)) }
            return
        } catch {
            DispatchQueue.main.async { self.finish(.failure(PolythLinkFailure(code: "camera-unavailable"))) }
            return
        }

        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.setTitleColor(.white, for: .normal)
        cancel.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        cancel.layer.cornerRadius = 18
        cancel.contentEdgeInsets = UIEdgeInsets(top: 8, left: 16, bottom: 8, right: 16)
        cancel.translatesAutoresizingMaskIntoConstraints = false
        cancel.addTarget(self, action: #selector(cancelScan), for: .touchUpInside)
        view.addSubview(cancel)
        NSLayoutConstraint.activate([
            cancel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            cancel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        sessionQueue.async { [weak self] in
            guard let self, !self.session.isRunning else { return }
            self.session.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    private func configureCamera() throws {
        guard let camera = AVCaptureDevice.default(for: .video) else {
            throw PolythLinkFailure(code: "camera-unavailable")
        }
        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: camera)
        } catch {
            throw PolythLinkFailure(code: "camera-unavailable")
        }
        guard session.canAddInput(input) else {
            throw PolythLinkFailure(code: "camera-unavailable")
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            throw PolythLinkFailure(code: "camera-unavailable")
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        guard output.availableMetadataObjectTypes.contains(.qr) else {
            throw PolythLinkFailure(code: "camera-unavailable")
        }
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.insertSublayer(preview, at: 0)
        previewLayer = preview
    }

    @objc private func cancelScan() {
        finish(.success(nil))
    }

    private func finish(_ result: Result<String?, PolythLinkFailure>) {
        guard !finished else { return }
        finished = true
        sessionQueue.async { [session] in
            if session.isRunning { session.stopRunning() }
        }
        let completion = self.completion
        dismiss(animated: true) { completion(result) }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        for case let object as AVMetadataMachineReadableCodeObject in metadataObjects {
            guard object.type == .qr,
                  let raw = object.stringValue,
                  raw.starts(with: "polyth://pair") else { continue }
            finish(.success(raw))
            return
        }
    }
}

@objc(PolythLinkPlugin)
final class PolythLinkPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "PolythLinkPlugin"
    let jsName = "PolythLink"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "parsePairingTicket", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginPairing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginNumericPairing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmPairing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelPairing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listConnections", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recoverConnection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetConnection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanPairingQr", returnType: CAPPluginReturnPromise),
    ]

    private let queue = DispatchQueue(label: "com.polyth.mobile.polyth-link", qos: .userInitiated)
    private let controlQueue = DispatchQueue(label: "com.polyth.mobile.polyth-link.control", qos: .userInitiated)
    private let keychain = PolythLinkKeychain()
    private let attemptsLock = NSLock()
    private let clientLock = NSLock()
    private var attempts: [String: PairingSecretRecord] = [:]
    private var clientHandle: UInt64 = 0
    private let lastConnectionKey = "polyth-link.last-connection-id"
    private let activeProxyOriginKey = "polyth-link.active-proxy-origin"
    private let proxyRecoveryAttemptsKey = "polyth-link.proxy-recovery-attempts"
    private let maximumAutomaticProxyRecoveries = 2
    private var recoveryGeneration: UInt64 = 0
    private var recoveryInFlight = false
    private var recoveryScheduled = false

    override public func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(restoreLoopbackTransport),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(suspendLoopbackTransport),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        clientLock.lock()
        let handle = clientHandle
        clientHandle = 0
        clientLock.unlock()
        if handle != 0 { polythLinkClientFree(handle) }
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

    static func ownsCurrentProxy(_ url: URL?) -> Bool {
        guard let url, let current = canonicalLoopbackOrigin(url),
              current == UserDefaults.standard.string(forKey: "polyth-link.active-proxy-origin"),
              UserDefaults.standard.string(forKey: "polyth-link.last-connection-id") != nil else { return false }
        return true
    }

    private static func canonicalLoopbackOrigin(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == "http", url.host == "127.0.0.1", let port = url.port else { return nil }
        return "http://127.0.0.1:\(port)"
    }

    private func loopbackContent() -> Bool {
        Self.ownsCurrentProxy(webView?.url)
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        let code = (error as? PolythLinkFailure)?.code ?? "transport-protocol-error"
        call.reject(code, code, error)
    }

    private func require(_ call: CAPPluginCall, _ key: String, code: String) -> String? {
        guard let value = call.getString(key), !value.isEmpty else {
            call.reject(code, code)
            return nil
        }
        return value
    }

    private func ensureClient() throws -> UInt64 {
        clientLock.lock()
        defer { clientLock.unlock() }
        if clientHandle != 0 { return clientHandle }
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("PolythLink", isDirectory: true)
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        guard let publicRoot = Bundle.main.resourceURL?.appendingPathComponent("public", isDirectory: true),
              FileManager.default.fileExists(atPath: publicRoot.path) else {
            throw PolythLinkFailure(code: "transport-unavailable")
        }
        let handle = root.path.withCString { dataDir in
            publicRoot.path.withCString { webDist in polythLinkClientNew(dataDir, webDist) }
        }
        guard handle != 0 else { throw PolythLinkFailure(code: "transport-unavailable") }
        clientHandle = handle
        return handle
    }

    private func hostID(_ ticket: String) throws -> String {
        guard let pointer = ticket.withCString({ polythLinkTicketHostID($0) }) else {
            throw PolythLinkFailure(code: "pairing-invalid")
        }
        defer { polythLinkStringFree(pointer) }
        return String(cString: pointer)
    }

    private func freshSecret() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        defer { for index in bytes.indices { bytes[index] = 0 } }
        let count = bytes.withUnsafeMutableBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return 0 }
            return polythLinkGenerateIdentitySecret(base, buffer.count)
        }
        guard count == 32 else { throw PolythLinkFailure(code: "pairing-storage-failed") }
        return Data(bytes)
    }

    private func identityEndpointID(_ secret: Data) throws -> String {
        guard secret.count == 32,
              let pointer = secret.withUnsafeBytes({ raw -> UnsafeMutablePointer<CChar>? in
                  let bytes = raw.bindMemory(to: UInt8.self)
                  guard let base = bytes.baseAddress else { return nil }
                  return polythLinkIdentityEndpointID(base, bytes.count)
              }) else {
            throw PolythLinkFailure(code: "pairing-storage-failed")
        }
        defer { polythLinkStringFree(pointer) }
        return String(cString: pointer)
    }

    private func invoke(_ method: String, _ params: [String: Any], secret originalSecret: Data? = nil) throws -> Any {
        let handle = try ensureClient()
        let encoded = try JSONSerialization.data(withJSONObject: params)
        guard let paramsJSON = String(data: encoded, encoding: .utf8) else {
            throw PolythLinkFailure(code: "pairing-invalid")
        }
        var secret = originalSecret
        defer {
            if secret != nil { secret!.resetBytes(in: 0..<secret!.count) }
        }
        let pointer = method.withCString { methodCString in
            paramsJSON.withCString { paramsCString in
                guard let secret else {
                    return polythLinkInvoke(handle, methodCString, paramsCString, nil, 0)
                }
                return secret.withUnsafeBytes { raw in
                    let bytes = raw.bindMemory(to: UInt8.self)
                    return polythLinkInvoke(handle, methodCString, paramsCString, bytes.baseAddress, bytes.count)
                }
            }
        }
        guard let pointer else { throw PolythLinkFailure(code: "transport-protocol-error") }
        defer { polythLinkStringFree(pointer) }
        let data = Data(String(cString: pointer).utf8)
        guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ok = envelope["ok"] as? Bool else {
            throw PolythLinkFailure(code: "transport-protocol-error")
        }
        if !ok { throw PolythLinkFailure(code: envelope["error"] as? String ?? "transport-protocol-error") }
        return envelope["result"] ?? NSNull()
    }

    private func object(_ value: Any) throws -> [String: Any] {
        guard let result = value as? [String: Any] else { throw PolythLinkFailure(code: "transport-protocol-error") }
        return result
    }

    private func setAttempt(_ attemptID: String, _ record: PairingSecretRecord) {
        attemptsLock.lock()
        attempts[attemptID] = record
        attemptsLock.unlock()
    }

    private func removeAttempt(_ attemptID: String) -> PairingSecretRecord? {
        attemptsLock.lock()
        defer { attemptsLock.unlock() }
        return attempts.removeValue(forKey: attemptID)
    }

    private func attemptHostIDs() -> Set<String> {
        attemptsLock.lock()
        defer { attemptsLock.unlock() }
        return Set(attempts.values.map(\.hostID))
    }

    private func listAndCleanOrphans() throws -> [[String: Any]] {
        guard let connections = try invoke("connections.list", [:]) as? [[String: Any]] else {
            throw PolythLinkFailure(code: "transport-protocol-error")
        }
        var keep = Set(connections.compactMap { $0["hostEndpointId"] as? String })
        keep.formUnion(attemptHostIDs())
        for hostID in try keychain.hostIDs() where !keep.contains(hostID) {
            try keychain.delete(hostID)
        }
        return connections
    }

    private func connectionMetadata(_ hostID: String) throws -> [String: Any]? {
        guard let connections = try invoke("connections.list", [:]) as? [[String: Any]] else {
            throw PolythLinkFailure(code: "transport-protocol-error")
        }
        return connections.first { ($0["hostEndpointId"] as? String) == hostID }
    }

    private func hasConnectionMetadata(_ hostID: String) throws -> Bool {
        try connectionMetadata(hostID) != nil
    }

    private func rememberTransport(_ connectionID: String, launch: [String: Any]) throws {
        guard let raw = launch["origin"] as? String, let url = URL(string: raw),
              let origin = Self.canonicalLoopbackOrigin(url) else { throw PolythLinkFailure(code: "proxy-bootstrap-invalid") }
        UserDefaults.standard.set(connectionID, forKey: lastConnectionKey)
        UserDefaults.standard.set(origin, forKey: activeProxyOriginKey)
        UserDefaults.standard.set(0, forKey: proxyRecoveryAttemptsKey)
    }

    private func forgetTransport(_ connectionID: String) {
        if UserDefaults.standard.string(forKey: lastConnectionKey) == connectionID {
            UserDefaults.standard.removeObject(forKey: lastConnectionKey)
            UserDefaults.standard.removeObject(forKey: activeProxyOriginKey)
        }
    }

    @objc private func suspendLoopbackTransport() {
        recoveryGeneration &+= 1
        recoveryInFlight = false
        recoveryScheduled = false
        // The renderer closes its WebSocket and cancels retry timers. Leave the
        // native link to normal OS suspension so foreground status can tell a
        // healthy suspended proxy from one that actually died.
    }

    @objc private func restoreLoopbackTransport() {
        guard loopbackContent(),
              let connectionID = UserDefaults.standard.string(forKey: lastConnectionKey),
              !connectionID.isEmpty,
              !recoveryScheduled,
              !recoveryInFlight else { return }
        recoveryScheduled = true
        recoveryInFlight = true
        recoveryGeneration &+= 1
        let generation = recoveryGeneration
        controlQueue.async {
            do {
                let status = try self.object(self.invoke("status", ["connectionId": connectionID]))
                if status["state"] as? String == "connected" {
                    DispatchQueue.main.async {
                        guard self.recoveryGeneration == generation else { return }
                        UserDefaults.standard.set(0, forKey: self.proxyRecoveryAttemptsKey)
                        self.recoveryInFlight = false
                    }
                    return
                }
                let attempts = UserDefaults.standard.integer(forKey: self.proxyRecoveryAttemptsKey)
                guard attempts < self.maximumAutomaticProxyRecoveries else {
                    self.showRecoveryHub(generation)
                    return
                }
                UserDefaults.standard.set(attempts + 1, forKey: self.proxyRecoveryAttemptsKey)
                guard var secret = try self.keychain.load(connectionID) else {
                    throw PolythLinkFailure(code: "host-identity-unavailable")
                }
                defer { secret.resetBytes(in: 0..<secret.count) }
                let result = try self.object(self.invoke("connect", ["connectionId": connectionID], secret: secret))
                guard let bootstrap = (result["bootstrapUrl"] as? String) ?? (result["bootstrap"] as? String),
                      let url = self.bootstrapWithCurrentPath(bootstrap) else {
                    throw PolythLinkFailure(code: "proxy-bootstrap-invalid")
                }
                DispatchQueue.main.async {
                    guard self.recoveryGeneration == generation, self.loopbackContent() else { return }
                    do { try self.rememberTransport(connectionID, launch: result) }
                    catch { self.showRecoveryHub(generation); return }
                    self.recoveryInFlight = false
                    self.webView?.load(URLRequest(url: url))
                }
            } catch {
                self.showRecoveryHub(generation)
            }
        }
    }

    private func showRecoveryHub(_ generation: UInt64) {
        DispatchQueue.main.async {
            guard self.recoveryGeneration == generation else { return }
            self.recoveryInFlight = false
            if self.loopbackContent(), let bundled = URL(string: "capacitor://localhost/?connectionError=proxy-recovery-failed") {
                self.webView?.load(URLRequest(url: bundled))
            }
        }
    }

    private func bootstrapWithCurrentPath(_ bootstrap: String) -> URL? {
        guard var components = URLComponents(string: bootstrap),
              let current = webView?.url,
              current.scheme?.lowercased() == "http",
              current.host == "127.0.0.1" else { return URL(string: bootstrap) }
        var path = current.path
        guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("\\"), !path.contains("\r"), !path.contains("\n") else {
            return URL(string: bootstrap)
        }
        if let query = current.query, !query.isEmpty { path += "?" + query }
        components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "next", value: path)]
        return components.url
    }

    private func presentPairingScanner(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard var presenter = self.bridge?.viewController else {
                call.reject("camera-unavailable", "camera-unavailable")
                return
            }
            while let next = presenter.presentedViewController { presenter = next }
            let scanner = PolythQRScannerViewController { result in
                switch result {
                case .success(let raw):
                    if let raw { call.resolve(["raw": raw]) } else { call.resolve([:]) }
                case .failure(let error):
                    self.reject(call, error)
                }
            }
            presenter.present(scanner, animated: true)
        }
    }

    @objc func parsePairingTicket(_ call: CAPPluginCall) {
        guard trusted(call), let raw = require(call, "raw", code: "pairing-invalid") else { return }
        queue.async { do { call.resolve(try self.object(self.invoke("pairing.parse", ["ticket": raw]))) } catch { self.reject(call, error) } }
    }

    @objc func beginPairing(_ call: CAPPluginCall) {
        guard trusted(call), let raw = require(call, "raw", code: "pairing-invalid") else { return }
        let label = call.getString("label") ?? "This phone"
        queue.async {
            do {
                let hostID = try self.hostID(raw)
                var secret = try self.keychain.load(hostID)
                defer {
                    if secret != nil { secret!.resetBytes(in: 0..<secret!.count) }
                }
                let created = secret == nil
                if secret == nil {
                    secret = try self.freshSecret()
                    try self.keychain.store(secret!, for: hostID)
                }
                do {
                    let result = try self.object(self.invoke("pairing.begin", ["ticket": raw, "label": label], secret: secret))
                    guard let attemptID = result["attemptId"] as? String else { throw PolythLinkFailure(code: "transport-protocol-error") }
                    self.setAttempt(attemptID, PairingSecretRecord(hostID: hostID, createdForAttempt: created))
                    call.resolve(result)
                } catch {
                    if created { try? self.keychain.delete(hostID) }
                    throw error
                }
            } catch { self.reject(call, error) }
        }
    }

    @objc func beginNumericPairing(_ call: CAPPluginCall) {
        guard trusted(call),
              let hostID = require(call, "hostEndpointId", code: "pairing-invalid"),
              let code = require(call, "code", code: "pairing-invalid") else { return }
        let label = call.getString("label") ?? "This phone"
        let addresses = call.getArray("addresses", String.self) ?? []
        let port = call.getInt("port")
        queue.async {
            do {
                var secret = try self.keychain.load(hostID)
                defer {
                    if secret != nil { secret!.resetBytes(in: 0..<secret!.count) }
                }
                let created = secret == nil
                if secret == nil {
                    secret = try self.freshSecret()
                    try self.keychain.store(secret!, for: hostID)
                }
                do {
                    var params: [String: Any] = [
                        "hostEndpointId": hostID,
                        "addresses": addresses,
                        "code": code,
                        "label": label,
                    ]
                    if let port { params["port"] = port }
                    let result = try self.object(self.invoke("pairing.begin_numeric", params, secret: secret))
                    guard let attemptID = result["attemptId"] as? String else { throw PolythLinkFailure(code: "transport-protocol-error") }
                    self.setAttempt(attemptID, PairingSecretRecord(hostID: hostID, createdForAttempt: created))
                    call.resolve(result)
                } catch {
                    if created { try? self.keychain.delete(hostID) }
                    throw error
                }
            } catch { self.reject(call, error) }
        }
    }

    @objc func confirmPairing(_ call: CAPPluginCall) {
        guard trusted(call), let attemptID = require(call, "attemptId", code: "pairing-invalid") else { return }
        queue.async {
            do {
                let result = try self.object(self.invoke("pairing.confirm", ["attemptId": attemptID]))
                _ = self.removeAttempt(attemptID)
                if let connectionID = result["connectionId"] as? String, !connectionID.isEmpty {
                    try self.rememberTransport(connectionID, launch: result)
                }
                call.resolve(result)
            } catch { self.reject(call, error) }
        }
    }

    @objc func cancelPairing(_ call: CAPPluginCall) {
        guard trusted(call), let attemptID = require(call, "attemptId", code: "pairing-invalid") else { return }
        controlQueue.async {
            do {
                _ = try self.invoke("pairing.cancel", ["attemptId": attemptID])
                if let record = self.removeAttempt(attemptID), record.createdForAttempt {
                    let hasMetadata = try self.hasConnectionMetadata(record.hostID)
                    if !hasMetadata { try self.keychain.delete(record.hostID) }
                }
                call.resolve(["ok": true])
            } catch { self.reject(call, error) }
        }
    }

    @objc func listConnections(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        queue.async {
            do {
                var connections = try self.listAndCleanOrphans()
                for index in connections.indices {
                    let hostID = connections[index]["hostEndpointId"] as? String ?? ""
                    var secret: Data?
                    if !hostID.isEmpty {
                        do { secret = try self.keychain.load(hostID) } catch { secret = nil }
                    }
                    connections[index]["hasSecureIdentity"] = secret != nil
                    if secret != nil { secret!.resetBytes(in: 0..<secret!.count) }
                }
                call.resolve(["connections": connections])
            } catch { self.reject(call, error) }
        }
    }

    @objc func connect(_ call: CAPPluginCall) {
        guard trusted(call), let connectionID = require(call, "connectionId", code: "device-unknown") else { return }
        queue.async {
            do {
                guard var secret = try self.keychain.load(connectionID) else { throw PolythLinkFailure(code: "host-identity-unavailable") }
                defer { secret.resetBytes(in: 0..<secret.count) }
                let result = try self.object(self.invoke("connect", ["connectionId": connectionID], secret: secret))
                try self.rememberTransport(connectionID, launch: result)
                call.resolve(result)
            } catch { self.reject(call, error) }
        }
    }

    @objc func recoverConnection(_ call: CAPPluginCall) {
        guard trusted(call), let connectionID = require(call, "connectionId", code: "device-unknown") else { return }
        queue.async {
            do {
                guard var secret = try self.keychain.load(connectionID) else { throw PolythLinkFailure(code: "host-identity-unavailable") }
                defer { secret.resetBytes(in: 0..<secret.count) }
                let identityID = try self.identityEndpointID(secret)
                let result = try self.object(self.invoke("connection.recover", ["connectionId": connectionID], secret: secret))
                switch result["state"] as? String {
                case "connected":
                    var launch = result
                    launch.removeValue(forKey: "state")
                    try self.rememberTransport(connectionID, launch: launch)
                    call.resolve(["state": "connected", "launch": launch])
                case "orphaned":
                    guard result["identityEndpointId"] as? String == identityID,
                          try self.connectionMetadata(connectionID)?["pairingState"] as? String == "prepared",
                          !self.attemptHostIDs().contains(connectionID) else {
                        throw PolythLinkFailure(code: "pairing-confirmation-required")
                    }
                    try self.keychain.delete(connectionID)
                    _ = try self.invoke("forget", ["connectionId": connectionID])
                    self.forgetTransport(connectionID)
                    call.resolve(["state": "needs-pairing", "connectionId": connectionID])
                default:
                    throw PolythLinkFailure(code: "transport-protocol-error")
                }
            } catch { self.reject(call, error) }
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        guard trusted(call), let connectionID = require(call, "connectionId", code: "device-unknown") else { return }
        controlQueue.async {
            do {
                _ = try self.invoke("disconnect", ["connectionId": connectionID])
                self.forgetTransport(connectionID)
                call.resolve(["ok": true])
            } catch { self.reject(call, error) }
        }
    }

    @objc func forgetConnection(_ call: CAPPluginCall) {
        guard trusted(call), let connectionID = require(call, "connectionId", code: "device-unknown") else { return }
        controlQueue.async {
            do {
                _ = try self.invoke("disconnect", ["connectionId": connectionID])
                PolythPushPlugin.shared.forgetConnection(connectionID)
                try self.keychain.delete(connectionID)
                _ = try self.invoke("forget", ["connectionId": connectionID])
                self.forgetTransport(connectionID)
                call.resolve(["ok": true])
            } catch { self.reject(call, error) }
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        guard trusted(call), let connectionID = require(call, "connectionId", code: "device-unknown") else { return }
        queue.async { do { call.resolve(try self.object(self.invoke("status", ["connectionId": connectionID]))) } catch { self.reject(call, error) } }
    }

    @objc func scanPairingQr(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            presentPairingScanner(call)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    if granted {
                        self.presentPairingScanner(call)
                    } else {
                        call.reject("camera-permission-denied", "camera-permission-denied")
                    }
                }
            }
        case .denied, .restricted:
            call.reject("camera-permission-denied", "camera-permission-denied")
        @unknown default:
            call.reject("camera-unavailable", "camera-unavailable")
        }
    }
}

@objc(PolythBridgeViewController)
final class PolythBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(PolythLinkPlugin())
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        PolythPushPlugin.shared.installNotificationDelegate()
        if let payload = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
            // This launch option is supplied for a user notification action;
            // Polyth does not rely on silent pushes. Persist only this tapped
            // cold-start payload, never a routine foreground receipt.
            PolythPushPlugin.shared.recordTapped(payload)
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PolythPushPlugin.shared.providerToken(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PolythPushPlugin.shared.providerRegistrationFailed()
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

/** Native push authority. Its plugin contract only returns semantic state, a
 * short-lived claim, and a validated pending notification id. APNs tokens,
 * relay management capabilities, binding material, and relay origin never
 * cross into JavaScript or ordinary storage. */
@objc(PolythPushPlugin)
final class PolythPushPlugin: CAPPlugin, CAPBridgedPlugin, UNUserNotificationCenterDelegate {
    static let shared = PolythPushPlugin()

    let identifier = "PolythPushPlugin"
    let jsName = "PolythPush"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumePendingOpen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setForeground", returnType: CAPPluginReturnPromise),
    ]

    private static let service = "com.polyth.mobile.native-push"
    private static let mappingIndex = "polyth-native-push.mapping-index"
    private static let pendingKey = "pending-open"
    private static let seenKey = "polyth-native-push.seen-notifications"
    private static let installMarker = "polyth-native-push.install-v1"
    private static let bindingDomain = "polyth-native-push-binding-v1\u{0}"
    private let queue = DispatchQueue(label: "com.polyth.mobile.native-push", qos: .userInitiated)
    private var pendingEnable: (call: CAPPluginCall, input: PushInput)?
    private var latestProviderToken: String?
    private var foregroundMapping: String?
    private weak var forwardedNotificationDelegate: UNUserNotificationCenterDelegate?

    private struct PushInput: Codable {
        let connectionId: String
        let hostEndpointId: String
        let deviceEndpointId: String
        let accountId: String
    }

    private struct PushMapping: Codable {
        let connectionId: String
        let hostEndpointId: String
        let deviceEndpointId: String
        let accountId: String
        let subscriptionId: String
        let manageToken: String
        let binding: String
    }

    private struct PendingOpen: Codable {
        let connectionId: String
        let accountId: String
        let notificationId: String
    }

    private struct ValidatedPush {
        let subscriptionId: String
        let notificationId: String
    }

    private final class RelayRedirectGuard: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    private let relayRedirectGuard = RelayRedirectGuard()
    private lazy var relaySession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        return URLSession(configuration: configuration, delegate: relayRedirectGuard, delegateQueue: nil)
    }()

    override public func load() {
        // Keychain may survive uninstall while UserDefaults does not. Never
        // treat an orphaned mapping or tap as identity recovery for a fresh
        // installation; the user must explicitly enable each server/account.
        if !UserDefaults.standard.bool(forKey: Self.installMarker) {
            secureRemoveAll()
            setMappingIds([])
            foregroundMapping = nil
            UserDefaults.standard.set(true, forKey: Self.installMarker)
        }
        installNotificationDelegate()
        // Re-register on every later launch that already has an explicit
        // mapping so APNs can return the current token. This never prompts;
        // the initial permission request still happens only in enable().
        if !mappingIds().isEmpty {
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    /** Capacitor's local-notification router remains responsible for every
     * non-Polyth-push notification. Installation is repeated after bridge load
     * so whichever delegate Capacitor installed is retained and forwarded. */
    func installNotificationDelegate() {
        let center = UNUserNotificationCenter.current()
        guard center.delegate !== self else { return }
        forwardedNotificationDelegate = center.delegate
        center.delegate = self
    }

    private func opaque(_ value: String?) -> Bool {
        guard let value else { return false }
        return value.range(of: "^[A-Za-z0-9._:-]{1,160}$", options: .regularExpression) != nil
    }

    private func subscriptionID(_ value: String?) -> Bool {
        guard let value else { return false }
        return value.range(of: "^sub_[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil
    }

    private func capability(_ value: String?) -> Bool {
        guard let value else { return false }
        return value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    }

    private func notificationID(_ value: String?) -> UUID? {
        guard let value, let uuid = UUID(uuidString: value) else { return nil }
        return uuid
    }

    private func payloadKind(_ value: String?) -> Bool {
        switch value {
        case "completed", "failed", "question", "permission", "subagent": return true
        default: return false
        }
    }

    private func tag(_ value: String?) -> Bool {
        guard let value, value.count <= 128 else { return false }
        return value.range(of: "^[A-Za-z0-9._:-]{1,128}$", options: .regularExpression) != nil
    }

    private func bundled(_ call: CAPPluginCall) -> Bool {
        guard let url = webView?.url else { return false }
        return url.scheme?.lowercased() == "capacitor" && url.host?.lowercased() == "localhost"
    }

    private func semanticReader(_ call: CAPPluginCall) -> Bool {
        bundled(call) || PolythLinkPlugin.ownsCurrentProxy(webView?.url)
    }

    private func requireBundled(_ call: CAPPluginCall) -> Bool {
        guard bundled(call) else { call.reject("forbidden", "forbidden"); return false }
        return true
    }

    private func requireSemanticReader(_ call: CAPPluginCall) -> Bool {
        guard semanticReader(call) else { call.reject("forbidden", "forbidden"); return false }
        return true
    }

    private func relayOrigin() -> URL? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "PolythPushRelayOrigin") as? String,
              !raw.isEmpty, !raw.contains("$("), let url = URL(string: raw), let host = url.host,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { return nil }
        if url.scheme?.lowercased() == "https" { return url }
        #if DEBUG
        if url.scheme?.lowercased() == "http" && (host == "127.0.0.1" || host == "localhost") { return url }
        #endif
        return nil
    }

    private func relayEnvironment() -> String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "PolythPushEnvironment") as? String,
              value == "sandbox" || value == "production" else { return nil }
        return value
    }

    private func mappingKey(_ subscriptionId: String) -> String { "mapping/\(subscriptionId)" }

    private func secureSet(_ data: Data, account: String) throws {
        let base: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: Self.service, kSecAttrAccount: account]
        let update = SecItemUpdate(base as CFDictionary, [kSecValueData: data] as CFDictionary)
        if update == errSecSuccess { return }
        if update != errSecItemNotFound { throw NSError(domain: "native-push", code: Int(update)) }
        var item = base; item[kSecValueData] = data; item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(item as CFDictionary, nil)
        guard added == errSecSuccess else { throw NSError(domain: "native-push", code: Int(added)) }
    }

    private func secureGet(_ account: String) throws -> Data? {
        var output: CFTypeRef?
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: Self.service, kSecAttrAccount: account, kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne]
        let status = SecItemCopyMatching(query as CFDictionary, &output)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw NSError(domain: "native-push", code: Int(status)) }
        return output as? Data
    }

    private func secureRemove(_ account: String) {
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: Self.service, kSecAttrAccount: account] as CFDictionary)
    }

    private func secureRemoveAll() {
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: Self.service] as CFDictionary)
    }

    private func mappingIds() -> [String] { UserDefaults.standard.stringArray(forKey: Self.mappingIndex) ?? [] }
    private func setMappingIds(_ ids: [String]) { UserDefaults.standard.set(ids, forKey: Self.mappingIndex) }
    private func store(_ mapping: PushMapping) throws {
        try secureSet(JSONEncoder().encode(mapping), account: mappingKey(mapping.subscriptionId))
        var ids = mappingIds().filter { $0 != mapping.subscriptionId }; ids.append(mapping.subscriptionId); setMappingIds(ids)
    }

    private func mappings() throws -> [PushMapping] {
        try mappingIds().compactMap { id in
            guard let data = try secureGet(mappingKey(id)) else { return nil }
            return try? JSONDecoder().decode(PushMapping.self, from: data)
        }
    }

    private func mapping(connectionId: String, accountId: String) throws -> PushMapping? {
        try mappings().first { $0.connectionId == connectionId && $0.accountId == accountId }
    }

    /** The native Link keychain is the source of both stable identities. The
     * account is the only binding input accepted from authenticated web code. */
    private func currentInput(accountId: String) throws -> PushInput {
        guard opaque(accountId), let connectionId = UserDefaults.standard.string(forKey: "polyth-link.last-connection-id"), opaque(connectionId), var secret = try PolythLinkKeychain().load(connectionId) else {
            throw NSError(domain: "native-push", code: 3)
        }
        defer { secret.resetBytes(in: 0..<secret.count) }
        let deviceId: String? = secret.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress?.assumingMemoryBound(to: UInt8.self), let raw = polythLinkIdentityEndpointID(base, secret.count) else { return nil }
            defer { polythLinkStringFree(raw) }
            return String(cString: raw)
        }
        guard opaque(deviceId) else { throw NSError(domain: "native-push", code: 3) }
        return PushInput(connectionId: connectionId, hostEndpointId: connectionId, deviceEndpointId: deviceId!, accountId: accountId)
    }

    private func active(_ input: PushInput) -> Bool {
        UserDefaults.standard.string(forKey: "polyth-link.last-connection-id") == input.connectionId
    }

    private func forget(_ mapping: PushMapping) {
        secureRemove(mappingKey(mapping.subscriptionId))
        setMappingIds(mappingIds().filter { $0 != mapping.subscriptionId })
    }

    /** Called from Polyth Link's native forget path before it removes the
     * trusted identity. It cannot touch mappings for other connections. */
    func forgetConnection(_ connectionId: String) {
        guard opaque(connectionId) else { return }
        queue.async {
            guard let items = try? self.mappings() else { return }
            for item in items where item.connectionId == connectionId {
                self.request("DELETE", path: "/v1/registrations/\(item.subscriptionId)", body: nil, manageToken: item.manageToken) { _ in }
                self.forget(item)
                if self.foregroundMapping == "\(connectionId)\u{0}\(item.accountId)" { self.foregroundMapping = nil }
            }
            if let data = try? self.secureGet(Self.pendingKey), let data,
               let pending = try? JSONDecoder().decode(PendingOpen.self, from: data), pending.connectionId == connectionId {
                self.secureRemove(Self.pendingKey)
            }
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        guard requireSemanticReader(call) else { return }
        guard relayOrigin() != nil, relayEnvironment() != nil else { call.resolve(["state": "unavailable", "reason": "relay-not-configured"]); return }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            if settings.authorizationStatus == .denied {
                call.resolve(["state": "denied", "reason": "permission-denied"]); return
            }
            self.queue.async {
                do {
                    if let key = self.foregroundMapping, let item = try self.mappings().first(where: { "\($0.connectionId)\u{0}\($0.accountId)" == key }) { call.resolve(["state": "enabled", "subscriptionId": item.subscriptionId]) }
                    else { call.resolve(["state": "disabled"]) }
                } catch { call.resolve(["state": "failed", "reason": "registration-failed"]) }
            }
        }
    }

    @objc func enable(_ call: CAPPluginCall) {
        guard requireSemanticReader(call), relayOrigin() != nil, relayEnvironment() != nil else {
            if relayOrigin() == nil || relayEnvironment() == nil { call.reject("relay-not-configured", "relay-not-configured") }
            return
        }
        guard let account = call.getString("accountId"), let input = try? currentInput(accountId: account) else {
            call.reject("push-binding-invalid", "push-binding-invalid"); return
        }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard self.active(input) else { call.reject("push-binding-invalid", "push-binding-invalid"); return }
            switch settings.authorizationStatus {
            case .denied: call.reject("permission-denied", "permission-denied")
            case .notDetermined:
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
                    guard granted else { call.reject("permission-denied", "permission-denied"); return }
                    self.awaitProviderRegistration(call, input)
                }
            default: self.awaitProviderRegistration(call, input)
            }
        }
    }

    private func awaitProviderRegistration(_ call: CAPPluginCall, _ input: PushInput) {
        queue.async {
            guard self.active(input) else { call.reject("push-binding-invalid", "push-binding-invalid"); return }
            self.pendingEnable = (call, input)
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            if let token = self.latestProviderToken { self.register(token: token, call: call, input: input) }
        }
    }

    @objc func disable(_ call: CAPPluginCall) {
        guard requireSemanticReader(call), let account = call.getString("accountId"), opaque(account) else {
            if opaque(call.getString("accountId")) == false { call.reject("push-binding-invalid", "push-binding-invalid") }
            return
        }
        guard let current = try? currentInput(accountId: account) else { call.reject("push-disable-failed", "push-disable-failed"); return }
        queue.async {
            do {
                guard self.active(current) else { throw PolythLinkFailure(code: "push-binding-invalid") }
                if let item = try self.mapping(connectionId: current.connectionId, accountId: account) {
                    self.request("DELETE", path: "/v1/registrations/\(item.subscriptionId)", body: nil, manageToken: item.manageToken) { _ in }
                    self.forget(item) // Network deletion is intentionally best effort; this mapping alone is forgotten.
                }
                call.resolve(["ok": true])
            } catch { call.reject("push-disable-failed", "push-disable-failed") }
        }
    }

    @objc func consumePendingOpen(_ call: CAPPluginCall) {
        // Cross-server routing belongs exclusively to the bundled Connection
        // Hub. Loopback server content cannot race it for another tap intent.
        guard requireBundled(call) else { return }
        queue.async {
            defer { self.secureRemove(Self.pendingKey) }
            guard let data = try? self.secureGet(Self.pendingKey), let data,
                  let pending = try? JSONDecoder().decode(PendingOpen.self, from: data),
                  self.opaque(pending.connectionId), self.opaque(pending.accountId), self.notificationID(pending.notificationId) != nil else { call.resolve([:]); return }
            call.resolve(["connectionId": pending.connectionId, "accountId": pending.accountId, "notificationId": pending.notificationId.lowercased()])
        }
    }

    @objc func setForeground(_ call: CAPPluginCall) {
        guard requireSemanticReader(call), let account = call.getString("accountId"), opaque(account) else {
            if opaque(call.getString("accountId")) == false { call.reject("push-binding-invalid", "push-binding-invalid") }
            return
        }
        guard let current = try? currentInput(accountId: account) else { call.reject("host-identity-unavailable", "host-identity-unavailable"); return }
        queue.async {
            guard self.active(current) else { call.reject("host-identity-unavailable", "host-identity-unavailable"); return }
            let key = "\(current.connectionId)\u{0}\(account)"
            self.foregroundMapping = call.getBool("active", false) ? key : (self.foregroundMapping == key ? nil : self.foregroundMapping)
            call.resolve()
        }
    }

    func providerToken(_ token: Data) {
        let value = token.map { String(format: "%02x", $0) }.joined()
        guard !value.isEmpty else { return }
        queue.async {
            self.latestProviderToken = value
            if let waiting = self.pendingEnable { self.register(token: value, call: waiting.call, input: waiting.input) }
            self.rotate(token: value)
        }
    }

    func providerRegistrationFailed() {
        queue.async { self.pendingEnable?.call.reject("push-unavailable", "push-unavailable"); self.pendingEnable = nil }
    }

    private func register(token: String, call: CAPPluginCall, input: PushInput) {
        pendingEnable = nil
        guard let binding = try? binding(input), let environment = relayEnvironment(), let body = try? JSONSerialization.data(withJSONObject: ["platform": "ios", "providerToken": token, "binding": binding, "environment": environment]) else {
            call.reject("push-registration-failed", "push-registration-failed"); return
        }
        request("POST", path: "/v1/registrations", body: body, manageToken: nil) { result in
            self.queue.async {
                guard case let .success(data) = result,
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let subscription = object["subscriptionId"] as? String, let manage = object["manageToken"] as? String,
                      let claim = object["claimToken"] as? String, let expires = object["claimExpiresAt"] as? NSNumber,
                      self.subscriptionID(subscription), self.capability(manage), self.capability(claim), expires.int64Value > Int64(Date().timeIntervalSince1970 * 1000) else {
                    call.reject("push-registration-failed", "push-registration-failed"); return
                }
                guard self.active(input) else {
                    self.request("DELETE", path: "/v1/registrations/\(subscription)", body: nil, manageToken: manage) { _ in }
                    call.reject("push-binding-invalid", "push-binding-invalid")
                    return
                }
                do {
                    let previous = try self.mappings().filter { $0.connectionId == input.connectionId && $0.accountId == input.accountId }
                    try self.store(PushMapping(connectionId: input.connectionId, hostEndpointId: input.hostEndpointId, deviceEndpointId: input.deviceEndpointId, accountId: input.accountId, subscriptionId: subscription, manageToken: manage, binding: binding))
                    // Explicit re-enable replaces this connection/account's
                    // prior destination instead of retaining stale senders.
                    for item in previous where item.subscriptionId != subscription {
                        self.request("DELETE", path: "/v1/registrations/\(item.subscriptionId)", body: nil, manageToken: item.manageToken) { _ in }
                        self.forget(item)
                    }
                    call.resolve(["subscriptionId": subscription, "claimToken": claim, "claimExpiresAt": expires])
                } catch {
                    // Best-effort rollback prevents an unmanageable live
                    // destination after local Keychain persistence fails.
                    self.request("DELETE", path: "/v1/registrations/\(subscription)", body: nil, manageToken: manage) { _ in }
                    call.reject("push-registration-failed", "push-registration-failed")
                }
            }
        }
    }

    private func rotate(token: String) {
        guard let items = try? mappings() else { return }
        for item in items {
            guard let body = try? JSONSerialization.data(withJSONObject: ["providerToken": token]) else { continue }
            request("PUT", path: "/v1/registrations/\(item.subscriptionId)", body: body, manageToken: item.manageToken) { _ in }
        }
    }

    private func binding(_ input: PushInput) throws -> String {
        let tuple = Self.bindingDomain + input.hostEndpointId + "\u{0}" + input.deviceEndpointId + "\u{0}" + input.accountId
        return Data(SHA256.hash(data: Data(tuple.utf8))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "").lowercased()
    }

    private func request(_ method: String, path: String, body: Data?, manageToken: String?, completion: @escaping (Result<Data, Error>) -> Void) {
        guard let origin = relayOrigin(), let url = URL(string: path, relativeTo: origin)?.absoluteURL else { completion(.failure(NSError(domain: "native-push", code: 1))); return }
        var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let manageToken { request.setValue("Bearer \(manageToken)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = body; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        relaySession.dataTask(with: request) { data, response, error in
            guard error == nil, let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { completion(.failure(NSError(domain: "native-push", code: 2))); return }
            completion(.success(data ?? Data()))
        }.resume()
    }

    private func validated(_ payload: [AnyHashable: Any]) -> ValidatedPush? {
        guard let version = payload["version"] as? NSNumber, version.intValue == 1,
              let subscription = payload["subscriptionId"] as? String, subscriptionID(subscription),
              let id = payload["notificationId"] as? String, let uuid = notificationID(id),
              let kind = payload["kind"] as? String, payloadKind(kind), let payloadTag = payload["tag"] as? String, tag(payloadTag) else { return nil }
        return ValidatedPush(subscriptionId: subscription, notificationId: uuid.uuidString.lowercased())
    }

    /** A pending open exists only after a user notification action. Receipt
     * validation is separate so foreground delivery cannot navigate. */
    func recordTapped(_ payload: [AnyHashable: Any]) {
        guard let push = validated(payload) else { return }
        queue.async {
            guard !self.seen(push.notificationId), let item = try? self.mappings().first(where: { $0.subscriptionId == push.subscriptionId }) else { return }
            let pending = PendingOpen(connectionId: item.connectionId, accountId: item.accountId, notificationId: push.notificationId)
            try? self.secureSet(JSONEncoder().encode(pending), account: Self.pendingKey)
            self.returnToConnectionHub()
        }
    }

    private func returnToConnectionHub() {
        DispatchQueue.main.async {
            guard let url = URL(string: "capacitor://localhost") else { return }
            self.webView?.load(URLRequest(url: url))
        }
    }

    private func seen(_ id: String) -> Bool {
        var ids = UserDefaults.standard.stringArray(forKey: Self.seenKey) ?? []
        if ids.contains(id) { return true }
        ids.append(id); if ids.count > 128 { ids.removeFirst(ids.count - 128) }
        UserDefaults.standard.set(ids, forKey: Self.seenKey); return false
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        guard let push = validated(notification.request.content.userInfo) else {
            if let forwardedNotificationDelegate {
                forwardedNotificationDelegate.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler)
            } else {
                completionHandler([])
            }
            return
        }
        queue.async {
            let current = try? self.mappings().first(where: { $0.subscriptionId == push.subscriptionId })
            let exact = current.map { "\($0.connectionId)\u{0}\($0.accountId)" == self.foregroundMapping } ?? false
            completionHandler(exact ? [] : [.banner, .list, .sound])
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        guard validated(response.notification.request.content.userInfo) != nil else {
            if let forwardedNotificationDelegate {
                forwardedNotificationDelegate.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
            } else {
                completionHandler()
            }
            return
        }
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier { recordTapped(response.notification.request.content.userInfo) }
        completionHandler()
    }
}
