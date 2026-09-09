import Foundation
import Security
import Capacitor

@_silgen_name("polyth_link_client_new")
private func polythLinkClientNew(_ dataDir: UnsafePointer<CChar>, _ webDist: UnsafePointer<CChar>?) -> UInt64

@_silgen_name("polyth_link_client_free")
private func polythLinkClientFree(_ handle: UInt64)

@_silgen_name("polyth_link_invoke")
private func polythLinkInvoke(
    _ handle: UInt64,
    _ method: UnsafePointer<CChar>,
    _ paramsJSON: UnsafePointer<CChar>,
    _ identitySecret: UnsafePointer<UInt8>?,
    _ identitySecretLength: Int
) -> UnsafeMutablePointer<CChar>?

@_silgen_name("polyth_link_generate_identity_secret")
private func polythLinkGenerateIdentitySecret(_ output: UnsafeMutablePointer<UInt8>, _ outputLength: Int) -> Int

@_silgen_name("polyth_link_ticket_host_id")
private func polythLinkTicketHostID(_ ticket: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

@_silgen_name("polyth_link_string_free")
private func polythLinkStringFree(_ value: UnsafeMutablePointer<CChar>)

private struct PolythLinkFailure: Error {
    let code: String
}

private final class PolythLinkKeychain {
    private let service = "com.polyth.mobile.polyth-link.identity"

    func load(hostID: String) throws -> Data? {
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

    func store(_ secret: Data, hostID: String) throws {
        guard secret.count == 32 else {
            throw PolythLinkFailure(code: "pairing-storage-failed")
        }
        let status = SecItemAdd([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: hostID,
            kSecValueData: secret,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ] as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw PolythLinkFailure(code: "pairing-storage-failed")
        }
    }

    func delete(hostID: String) throws {
        let status = SecItemDelete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: hostID,
        ] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw PolythLinkFailure(code: "pairing-storage-failed")
        }
    }
}

private struct PairingSecretRecord {
    let hostID: String
    let createdForAttempt: Bool
}

@objc(PolythLinkPlugin)
public final class PolythLinkPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PolythLinkPlugin"
    public let jsName = "PolythLink"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "parsePairingTicket", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginPairing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmPairing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelPairing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listConnections", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetConnection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
    ]

    private let queue = DispatchQueue(label: "com.polyth.mobile.polyth-link", qos: .userInitiated)
    private let keychain = PolythLinkKeychain()
    private var attempts: [String: PairingSecretRecord] = [:]
    private var clientHandle: UInt64 = 0

    deinit {
        if clientHandle != 0 {
            polythLinkClientFree(clientHandle)
        }
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        let code = (error as? PolythLinkFailure)?.code ?? "transport-protocol-error"
        call.reject(code, code, error)
    }

    private func requireTrustedOrigin(_ call: CAPPluginCall) -> Bool {
        guard let url = webView?.url,
              url.scheme?.lowercased() == "capacitor",
              url.host?.lowercased() == "localhost" else {
            call.reject("forbidden", "forbidden")
            return false
        }
        return true
    }

    private func ensureClient() throws -> UInt64 {
        if clientHandle != 0 { return clientHandle }
        let root = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ).appendingPathComponent("PolythLink", isDirectory: true)
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
            publicRoot.path.withCString { webDist in
                polythLinkClientNew(dataDir, webDist)
            }
        }
        guard handle != 0 else {
            throw PolythLinkFailure(code: "transport-unavailable")
        }
        clientHandle = handle
        return handle
    }

    private func hostID(ticket: String) throws -> String {
        let pointer = ticket.withCString { polythLinkTicketHostID($0) }
        guard let pointer else {
            throw PolythLinkFailure(code: "pairing-invalid")
        }
        defer { polythLinkStringFree(pointer) }
        return String(cString: pointer)
    }

    private func generateSecret() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        defer { bytes.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) } }
        let written = bytes.withUnsafeMutableBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return 0 }
            return polythLinkGenerateIdentitySecret(base, buffer.count)
        }
        guard written == 32 else {
            throw PolythLinkFailure(code: "pairing-storage-failed")
        }
        return Data(bytes)
    }

    private func invoke(_ method: String, params: [String: Any], secret: Data? = nil) throws -> Any {
        let handle = try ensureClient()
        let paramsData = try JSONSerialization.data(withJSONObject: params, options: [])
        guard let paramsJSON = String(data: paramsData, encoding: .utf8) else {
            throw PolythLinkFailure(code: "pairing-invalid")
        }
        let pointer: UnsafeMutablePointer<CChar>? = method.withCString { methodCString in
            paramsJSON.withCString { paramsCString in
                if var secret {
                    defer { secret.resetBytes(in: 0..<secret.count) }
                    return secret.withUnsafeBytes { raw in
                        let bytes = raw.bindMemory(to: UInt8.self)
                        return polythLinkInvoke(handle, methodCString, paramsCString, bytes.baseAddress, bytes.count)
                    }
                }
                return polythLinkInvoke(handle, methodCString, paramsCString, nil, 0)
            }
        }
        guard let pointer else {
            throw PolythLinkFailure(code: "transport-protocol-error")
        }
        defer { polythLinkStringFree(pointer) }
        let response = Data(String(cString: pointer).utf8)
        guard let envelope = try JSONSerialization.jsonObject(with: response) as? [String: Any],
              let ok = envelope["ok"] as? Bool else {
            throw PolythLinkFailure(code: "transport-protocol-error")
        }
        if !ok {
            throw PolythLinkFailure(code: envelope["error"] as? String ?? "transport-protocol-error")
        }
        return envelope["result"] ?? NSNull()
    }

    private func dictionary(_ result: Any) throws -> [String: Any] {
        guard let dictionary = result as? [String: Any] else {
            throw PolythLinkFailure(code: "transport-protocol-error")
        }
        return dictionary
    }

    @objc public func parsePairingTicket(_ call: CAPPluginCall) {
        guard requireTrustedOrigin(call), let raw = call.getString("raw") else {
            if call.getString("raw") == nil { call.reject("pairing-invalid", "pairing-invalid") }
            return
        }
        queue.async {
            do { call.resolve(try self.dictionary(self.invoke("pairing.parse", params: ["ticket": raw]))) }
            catch { self.reject(call, error) }
        }
    }

    @objc public func beginPairing(_ call: CAPPluginCall) {
        guard requireTrustedOrigin(call), let raw = call.getString("raw") else {
            if call.getString("raw") == nil { call.reject("pairing-invalid", "pairing-invalid") }
            return
        }
        let label = call.getString("label") ?? "This phone"
        queue.async {
            do {
                let hostID = try self.hostID(ticket: raw)
                var secret = try self.keychain.load(hostID: hostID)
                let created = secret == nil
                if secret == nil {
                    secret = try self.generateSecret()
                    try self.keychain.store(secret!, hostID: hostID)
                }
                do {
                    let result = try self.dictionary(self.invoke(
                        "pairing.begin",
                        params: ["ticket": raw, "label": label],
                        secret: secret
                    ))
                    guard let attemptID = result["attemptId"] as? String else {
                        throw PolythLinkFailure(code: "transport-protocol-error")
                    }
                    self.attempts[attemptID] = PairingSecretRecord(
                        hostID: hostID,
                        createdForAttempt: created
                    )
                    call.resolve(result)
                } catch {
                    if created { try? self.keychain.delete(hostID: hostID) }
                    throw error
                }
            } catch { self.reject(call, error) }
        }
    }

    @objc public func confirmPairing(_ call: CAPPluginCall) {
        guard requireTrustedOrigin(call), let attemptID = call.getString("attemptId") else {
            if call.getString("attemptId") == nil { call.reject("pairing-invalid", "pairing-invalid") }
            return
        }
        queue.async {
            do {
                let result = try self.dictionary(self.invoke("pairing.confirm", params: ["attemptId": attemptID]))
                self.attempts.removeValue(forKey: attemptID)
                call.resolve(result)
            } catch { self.reject(call, error) }
        }
    }

    @objc public func cancelPairing(_ call: CAPPluginCall) {
        guard requireTrustedOrigin(call), let attemptID = call.getString("attemptId") else {
            if call.getString("attemptId") == nil { call.reject("pairing-invalid", "pairing-invalid") }
            return
        }
        queue.async {
            do {
                _ = try self.invoke("pairing.cancel", params: ["attemptId": attemptID])
                if let record = self.attempts.removeValue(forKey: attemptID), record.createdForAttempt {
                    try self.keychain.delete(hostID: record.hostID)
                }
                call.resolve(["ok": true])
            } catch { self.reject(call, error) }
        }
    }

    @objc public func listConnections(_ call: CAPPluginCall) {
        guard requireTrustedOrigin(call) else { return }
        queue.async {
            do {
                guard var connections = try self.invoke("connections.list", params: [:]) as? [[String: Any]] else {
                    throw PolythLinkFailure(code: "transport-protocol-error")
                }
                for index in connections.indices {
                    let hostID = connections[index]["hostEndpointId"] as? String ?? ""
                    connections[index]["hasSecureIdentity"] = !hostID.isEmpty && (try self.keychain.load(hostID: hostID) != nil)
                }
                call.resolve(["connections": connections])
            } catch { self.reject(call, error) }
        }
    }

    @objc public func connect(_ call: CAPPluginCall) {
        guard requireTrustedOrigin(call), let connectionID = call.getString("connectionId") else {
            if call.getString("connectionId") == nil { call.reject("device-unknown", "device-unknown") }
            return
        }
        queue.async {
            do {
                guard let secret = try self.keychain.load(hostID: connectionID) else {
                    throw PolythLinkFailure(code: "host-identity-unavailable")
                }
                call.resolve(try self.dictionary(self.invoke(
                    "connect",
                    params: ["connectionId": connectionID],
                    secret: secret
                )))
            } catch { self.reject(call, error) }
        }
    }

    @objc public func disconnect(_ call: CAPPluginCall) {
        guard requireTrustedOrigin(call), let connectionID = call.getString("connectionId") else {
            if call.getString("connectionId") == nil { call.reject("device-unknown", "device-unknown") }
            return
        }
        queue.async {
            do {
                _ = try self.invoke("disconnect", params: ["connectionId": connectionID])
                call.resolve(["ok": true])
            } catch { self.reject(call, error) }
        }
    }

    @objc public func forgetConnection(_ call: CAPPluginCall) {
        guard requireTrustedOrigin(call), let connectionID = call.getString("connectionId") else {
            if call.getString("connectionId") == nil { call.reject("device-unknown", "device-unknown") }
            return
        }
        queue.async {
            do {
                _ = try self.invoke("forget", params: ["connectionId": connectionID])
                try self.keychain.delete(hostID: connectionID)
                call.resolve(["ok": true])
            } catch { self.reject(call, error) }
        }
    }

    @objc public func getStatus(_ call: CAPPluginCall) {
        guard requireTrustedOrigin(call), let connectionID = call.getString("connectionId") else {
            if call.getString("connectionId") == nil { call.reject("device-unknown", "device-unknown") }
            return
        }
        queue.async {
            do { call.resolve(try self.dictionary(self.invoke("status", params: ["connectionId": connectionID]))) }
            catch { self.reject(call, error) }
        }
    }
}

@objc(PolythBridgeViewController)
public final class PolythBridgeViewController: CAPBridgeViewController {
    public override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(PolythLinkPlugin())
    }
}
