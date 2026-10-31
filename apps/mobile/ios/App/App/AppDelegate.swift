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

/** One paired server in the native server menu. */
private struct PolythServerMenuItem {
    let id: String
    let title: String
    let detail: String
    let current: Bool
    let enabled: Bool
}

private enum PolythServerMenuChoice {
    case server(String)
    case add
    case cancel
}

/** A menu row: symbol, title over a quiet detail line, a check on the open server. */
private final class PolythServerMenuRow: UIControl {
    private let wash = UIView()
    private let line = UIStackView()

    init(symbol: String, title: String, detail: String?, checked: Bool, accent: Bool) {
        super.init(frame: .zero)
        wash.backgroundColor = UIColor.label.withAlphaComponent(0.09)
        wash.alpha = 0
        wash.isUserInteractionEnabled = false
        wash.translatesAutoresizingMaskIntoConstraints = false
        addSubview(wash)

        let icon = UIImageView(image: UIImage(
            systemName: symbol,
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: accent ? .semibold : .regular)
        ))
        icon.tintColor = accent ? .tintColor : .label
        icon.contentMode = .center
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.setContentHuggingPriority(.required, for: .horizontal)

        let titleLabel = UILabel()
        titleLabel.text = title
        titleLabel.font = UIFont.preferredFont(forTextStyle: .body)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.textColor = accent ? .tintColor : .label
        titleLabel.lineBreakMode = .byTruncatingTail

        let copy = UIStackView(arrangedSubviews: [titleLabel])
        copy.axis = .vertical
        copy.spacing = 1
        if let detail, !detail.isEmpty {
            let detailLabel = UILabel()
            detailLabel.text = detail
            detailLabel.font = UIFont.preferredFont(forTextStyle: .footnote)
            detailLabel.adjustsFontForContentSizeCategory = true
            detailLabel.textColor = .secondaryLabel
            detailLabel.lineBreakMode = .byTruncatingTail
            copy.addArrangedSubview(detailLabel)
        }

        let check = UIImageView(image: UIImage(
            systemName: "checkmark",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
        ))
        check.tintColor = .tintColor
        check.alpha = checked ? 1 : 0
        check.setContentHuggingPriority(.required, for: .horizontal)
        check.setContentCompressionResistancePriority(.required, for: .horizontal)

        for part in [icon, copy, check] { line.addArrangedSubview(part) }
        line.axis = .horizontal
        line.alignment = .center
        line.spacing = 12
        line.isUserInteractionEnabled = false
        line.translatesAutoresizingMaskIntoConstraints = false
        addSubview(line)

        NSLayoutConstraint.activate([
            wash.topAnchor.constraint(equalTo: topAnchor),
            wash.bottomAnchor.constraint(equalTo: bottomAnchor),
            wash.leadingAnchor.constraint(equalTo: leadingAnchor),
            wash.trailingAnchor.constraint(equalTo: trailingAnchor),
            icon.widthAnchor.constraint(equalToConstant: 26),
            line.centerYAnchor.constraint(equalTo: centerYAnchor),
            line.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            line.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 50),
        ])
        // Comfortable padding when the text is large; the 50 pt floor wins otherwise.
        let top = line.topAnchor.constraint(equalTo: topAnchor, constant: 10)
        let bottom = line.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10)
        top.priority = UILayoutPriority(999)
        bottom.priority = UILayoutPriority(999)
        NSLayoutConstraint.activate([top, bottom])

        isAccessibilityElement = true
        accessibilityLabel = [title, detail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
        accessibilityTraits = checked ? [.button, .selected] : .button
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /** The finger's wash shows at once and lifts quickly: the row answers touch-down. */
    override var isHighlighted: Bool {
        didSet {
            guard isHighlighted != oldValue else { return }
            if isHighlighted { wash.alpha = 1; return }
            UIView.animate(withDuration: 0.18, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                self.wash.alpha = 0
            }
        }
    }

    override var isEnabled: Bool {
        didSet {
            // The content dims, not the row: the menu's entrance animates row alpha.
            line.alpha = isEnabled ? 1 : 0.38
            accessibilityTraits = isEnabled
                ? accessibilityTraits.subtracting(.notEnabled)
                : accessibilityTraits.union(.notEnabled)
        }
    }

    /** Keep the wash on the chosen row while the menu closes. */
    func hold() {
        wash.layer.removeAllAnimations()
        wash.alpha = 1
    }
}

/**
 * The server menu the open server's page asks for at its server button. It is
 * drawn here, not in the page: the page is that server's content and never
 * sees the other paired servers. Glass panel springing out of the button,
 * rows settling just after it; any touch outside closes it.
 */
private final class PolythServerMenuViewController: UIViewController, UIGestureRecognizerDelegate {
    private let items: [PolythServerMenuItem]
    private let anchor: CGRect
    private let completion: (PolythServerMenuChoice) -> Void
    private let panel = UIView()
    private let glass = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterial))
    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private var rows: [UIView] = []
    private let header = UILabel()
    private var finished = false
    private var opened = false
    private var opensBelow = true

    private let margin: CGFloat = 12
    private let gap: CGFloat = 8

    init(items: [PolythServerMenuItem], anchor: CGRect, completion: @escaping (PolythServerMenuChoice) -> Void) {
        self.items = items
        self.anchor = anchor
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        let outside = UITapGestureRecognizer(target: self, action: #selector(tapOutside))
        outside.delegate = self
        view.addGestureRecognizer(outside)

        panel.layer.shadowColor = UIColor.black.cgColor
        panel.layer.shadowOpacity = 0.22
        panel.layer.shadowRadius = 28
        panel.layer.shadowOffset = CGSize(width: 0, height: 10)
        panel.accessibilityViewIsModal = true
        view.addSubview(panel)

        glass.layer.cornerRadius = 16
        glass.layer.cornerCurve = .continuous
        glass.clipsToBounds = true
        glass.layer.borderWidth = 1 / max(UIScreen.main.scale, 1)
        glass.layer.borderColor = UIColor.separator.withAlphaComponent(0.35).cgColor
        panel.addSubview(glass)

        scroll.showsVerticalScrollIndicator = false
        scroll.alwaysBounceVertical = false
        scroll.delaysContentTouches = false
        glass.contentView.addSubview(scroll)

        stack.axis = .vertical
        stack.spacing = 0
        scroll.addSubview(stack)

        header.text = "Servers"
        header.font = UIFont.preferredFont(forTextStyle: .footnote)
        header.adjustsFontForContentSizeCategory = true
        header.textColor = .secondaryLabel
        header.accessibilityTraits = .header
        let headerBox = UIView()
        header.translatesAutoresizingMaskIntoConstraints = false
        headerBox.addSubview(header)
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: headerBox.topAnchor, constant: 12),
            header.bottomAnchor.constraint(equalTo: headerBox.bottomAnchor, constant: -4),
            header.leadingAnchor.constraint(equalTo: headerBox.leadingAnchor, constant: 16),
            header.trailingAnchor.constraint(equalTo: headerBox.trailingAnchor, constant: -16),
        ])
        add(headerBox)

        for (index, item) in items.enumerated() {
            if index > 0 { add(hairline(inset: 52)) }
            let row = PolythServerMenuRow(
                symbol: "desktopcomputer",
                title: item.title,
                detail: item.detail,
                checked: item.current,
                accent: false
            )
            row.isEnabled = item.enabled
            let id = item.id
            row.addAction(UIAction { [weak self, weak row] _ in
                row?.hold()
                self?.finish(.server(id))
            }, for: .touchUpInside)
            add(row)
        }

        // A thicker gap sets the action apart from the list, as a system menu does.
        if !items.isEmpty { add(sectionGap()) }
        let addRow = PolythServerMenuRow(
            symbol: "plus",
            title: "Add server",
            detail: "Scan a QR code or pair nearby",
            checked: false,
            accent: true
        )
        addRow.addAction(UIAction { [weak self, weak addRow] _ in
            addRow?.hold()
            self?.finish(.add)
        }, for: .touchUpInside)
        add(addRow)
    }

    private func add(_ row: UIView) {
        stack.addArrangedSubview(row)
        rows.append(row)
    }

    private func hairline(inset: CGFloat) -> UIView {
        let box = UIView()
        let line = UIView()
        line.backgroundColor = UIColor.separator
        line.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(line)
        NSLayoutConstraint.activate([
            line.topAnchor.constraint(equalTo: box.topAnchor),
            line.bottomAnchor.constraint(equalTo: box.bottomAnchor),
            line.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: inset),
            line.trailingAnchor.constraint(equalTo: box.trailingAnchor),
            line.heightAnchor.constraint(equalToConstant: 1 / max(UIScreen.main.scale, 1)),
        ])
        return box
    }

    private func sectionGap() -> UIView {
        let gap = UIView()
        gap.backgroundColor = UIColor.label.withAlphaComponent(0.06)
        gap.heightAnchor.constraint(equalToConstant: 8).isActive = true
        return gap
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard !finished else { return }
        let bounds = view.bounds
        let safe = view.safeAreaInsets
        let width = min(300, bounds.width - margin * 2)
        // Each row sizes itself; the stack itself is placed by frame.
        let content = ceil(rows.reduce(CGFloat(0)) { total, row in
            total + row.systemLayoutSizeFitting(
                CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
                withHorizontalFittingPriority: .required,
                verticalFittingPriority: .fittingSizeLevel
            ).height
        })

        let spaceBelow = bounds.height - safe.bottom - margin - (anchor.maxY + gap)
        let spaceAbove = anchor.minY - gap - (safe.top + margin)
        opensBelow = content <= spaceBelow || spaceBelow >= spaceAbove
        let height = min(content, max(120, opensBelow ? spaceBelow : spaceAbove))
        let y = opensBelow ? anchor.maxY + gap : anchor.minY - gap - height

        // Hang off the button's outer edge: right-hand buttons open leftwards.
        let preferredX = anchor.midX > bounds.midX ? anchor.maxX - width : anchor.minX
        let x = min(max(preferredX, safe.left + margin), bounds.width - safe.right - margin - width)

        let frame = CGRect(x: x, y: y, width: width, height: height)
        if !opened {
            panel.transform = .identity
            panel.frame = frame
        } else {
            panel.bounds = CGRect(origin: .zero, size: frame.size)
            panel.center = CGPoint(x: frame.midX, y: frame.midY)
        }
        panel.layer.shadowPath = UIBezierPath(roundedRect: panel.bounds, cornerRadius: 16).cgPath
        glass.frame = panel.bounds
        scroll.frame = CGRect(origin: .zero, size: panel.bounds.size)
        stack.frame = CGRect(x: 0, y: 0, width: width, height: content)
        scroll.contentSize = CGSize(width: width, height: content)
        scroll.isScrollEnabled = content > height + 0.5
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIAccessibility.post(notification: .screenChanged, argument: header)
    }

    /** Started before the first frame: the panel never shows at rest before it springs. */
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        guard !opened, !finished else { return }
        if view.bounds.isEmpty, let window = presentingViewController?.view.window {
            view.frame = window.bounds
        }
        view.layoutIfNeeded()
        opened = true

        if UIAccessibility.isReduceMotionEnabled {
            panel.alpha = 0
            UIView.animate(withDuration: 0.16, delay: 0, options: [.curveEaseOut, .allowUserInteraction]) {
                self.panel.alpha = 1
            }
            return
        }

        panel.alpha = 0
        panel.transform = collapsed(scale: 0.72)
        for row in rows {
            row.alpha = 0
            row.transform = CGAffineTransform(translationX: 0, y: opensBelow ? -6 : 6)
        }
        // A short, well-damped spring: the panel is there almost at once and
        // settles without wobble.
        let spring = UIViewPropertyAnimator(duration: 0.34, dampingRatio: 0.84) {
            self.panel.transform = .identity
        }
        spring.isInterruptible = true
        spring.startAnimation()
        UIView.animate(withDuration: 0.12, delay: 0, options: [.curveLinear, .allowUserInteraction]) {
            self.panel.alpha = 1
        }
        for (index, row) in rows.enumerated() {
            UIView.animate(
                withDuration: 0.22,
                delay: 0.03 + Double(min(index, 8)) * 0.014,
                options: [.curveEaseOut, .allowUserInteraction]
            ) {
                row.alpha = 1
                row.transform = .identity
            }
        }
    }

    /** Scaled toward the button the menu came from. */
    private func collapsed(scale: CGFloat) -> CGAffineTransform {
        // From center and bounds: the frame of a transformed view is not its layout box.
        let center = panel.center
        let half = CGSize(width: panel.bounds.width / 2, height: panel.bounds.height / 2)
        let pivot = CGPoint(
            x: min(max(anchor.midX - center.x, -half.width), half.width),
            y: opensBelow ? -half.height : half.height
        )
        return CGAffineTransform(translationX: (1 - scale) * pivot.x, y: (1 - scale) * pivot.y)
            .scaledBy(x: scale, y: scale)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard let touched = touch.view else { return true }
        return !touched.isDescendant(of: panel)
    }

    @objc private func tapOutside() {
        finish(.cancel)
    }

    override func accessibilityPerformEscape() -> Bool {
        finish(.cancel)
        return true
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        // The button moves with the layout; a menu left at its old place would point at nothing.
        finish(.cancel, animated: false)
    }

    /** Close fast (the choice is already made), then report it. */
    func finish(_ choice: PolythServerMenuChoice, animated: Bool = true) {
        guard !finished else { return }
        finished = true
        view.isUserInteractionEnabled = false
        if case .cancel = choice {} else { UISelectionFeedbackGenerator().selectionChanged() }
        let completion = self.completion
        let close = { [weak self] in
            guard let self else { completion(choice); return }
            self.dismiss(animated: false) { completion(choice) }
        }
        guard animated else { close(); return }
        let reduce = UIAccessibility.isReduceMotionEnabled
        let target = reduce ? panel.transform : collapsed(scale: 0.94)
        UIView.animate(
            withDuration: reduce ? 0.12 : 0.15,
            delay: 0,
            options: [.curveEaseIn, .beginFromCurrentState],
            animations: {
                self.panel.alpha = 0
                self.panel.transform = target
            },
            completion: { _ in close() }
        )
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
        CAPPluginMethod(name: "presentServerMenu", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumeServerChoice", returnType: CAPPluginReturnPromise),
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
    /** Main thread only. The server picked from the server menu, for the hub to open. */
    private var pendingServerChoice: (connectionID: String, at: Date)?
    private var serverMenuOpen = false
    private let serverChoiceLifetime: TimeInterval = 60

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

    /**
     * The server button of the open server's page. Only that page (the proxy
     * this app opened) or the hub may ask, and the list never crosses into
     * JavaScript: the page learns only the kind of choice. A picked server is
     * held here for the bundled hub, which opens it (`consumeServerChoice`).
     */
    @objc func presentServerMenu(_ call: CAPPluginCall) {
        guard loopbackContent() || isBundledContent() else {
            call.reject("forbidden", "forbidden")
            return
        }
        guard let x = call.getDouble("x"), let y = call.getDouble("y"),
              let width = call.getDouble("width"), let height = call.getDouble("height"),
              [x, y, width, height].allSatisfy({ $0.isFinite }), width >= 0, height >= 0 else {
            call.reject("menu-invalid", "menu-invalid")
            return
        }
        let anchor = CGRect(x: x, y: y, width: width, height: height)
        queue.async {
            let items: [PolythServerMenuItem]
            do { items = try self.serverMenuItems() } catch { self.reject(call, error); return }
            DispatchQueue.main.async { self.showServerMenu(call, items: items, anchor: anchor) }
        }
    }

    @objc func consumeServerChoice(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        DispatchQueue.main.async {
            let choice = self.pendingServerChoice
            self.pendingServerChoice = nil
            guard let choice, Date().timeIntervalSince(choice.at) < self.serverChoiceLifetime else {
                call.resolve([:])
                return
            }
            call.resolve(["connectionId": choice.connectionID])
        }
    }

    private func isBundledContent() -> Bool {
        guard let url = webView?.url else { return false }
        return url.scheme?.lowercased() == "capacitor" && url.host?.lowercased() == "localhost"
    }

    /** Newest first, the open server on top. Reads only; orphan cleanup stays with the hub. */
    private func serverMenuItems() throws -> [PolythServerMenuItem] {
        guard let connections = try invoke("connections.list", [:]) as? [[String: Any]] else {
            throw PolythLinkFailure(code: "transport-protocol-error")
        }
        let current = UserDefaults.standard.string(forKey: lastConnectionKey)
        let sorted = connections.sorted {
            (($0["lastUsedAt"] as? NSNumber)?.doubleValue ?? 0) > (($1["lastUsedAt"] as? NSNumber)?.doubleValue ?? 0)
        }
        let items = sorted.compactMap { connection -> PolythServerMenuItem? in
            guard let id = connection["id"] as? String, !id.isEmpty else { return nil }
            let hostID = connection["hostEndpointId"] as? String ?? id
            var hasIdentity = false
            if var secret = try? keychain.load(hostID) {
                hasIdentity = true
                secret.resetBytes(in: 0..<secret.count)
            }
            let state = connection["pairingState"] as? String
            let revoked = (connection["revoked"] as? Bool ?? false) || state == "revoked"
            let isCurrent = id == current
            let label = (connection["hostLabel"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Polyth"
            let detail: String
            if isCurrent { detail = "Connected" }
            else if revoked { detail = "Revoked" }
            else if !hasIdentity { detail = "Pair again to use" }
            else if state == "prepared" { detail = "Pairing interrupted" }
            else { detail = connection["lastTransport"] as? String == "relay" ? "Ready · via relay" : "Ready" }
            return PolythServerMenuItem(
                id: id,
                title: label,
                detail: detail,
                current: isCurrent,
                enabled: isCurrent || (!revoked && hasIdentity)
            )
        }
        return items.filter(\.current) + items.filter { !$0.current }
    }

    private func showServerMenu(_ call: CAPPluginCall, items: [PolythServerMenuItem], anchor: CGRect) {
        guard !serverMenuOpen else { call.reject("busy", "busy"); return }
        guard loopbackContent() || isBundledContent(),
              let webView, var presenter = bridge?.viewController else {
            call.reject("forbidden", "forbidden")
            return
        }
        while let next = presenter.presentedViewController { presenter = next }
        // The page measures its button in CSS pixels of the viewport, which is
        // the web view's own space (no content inset, page scale 1).
        let bounds = webView.bounds
        let clamped = anchor.intersection(bounds).isNull ? CGRect(x: bounds.maxX - 44, y: bounds.minY, width: 44, height: 44) : anchor
        let inWindow = webView.convert(clamped, to: nil)
        serverMenuOpen = true
        let current = items.first(where: \.current)?.id
        let menu = PolythServerMenuViewController(items: items, anchor: inWindow) { choice in
            self.serverMenuOpen = false
            switch choice {
            case .server(let id) where id == current:
                call.resolve(["action": "current"])
            case .server(let id):
                self.pendingServerChoice = (id, Date())
                call.resolve(["action": "switch"])
            case .add:
                self.pendingServerChoice = nil
                call.resolve(["action": "add"])
            case .cancel:
                call.resolve(["action": "cancel"])
            }
        }
        presenter.present(menu, animated: false)
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
    /** Sealed-content key shared with the Notification Service Extension:
     * a generic password, account = subscription id, value = 32-byte raw P-256
     * private key followed by the 16-byte auth secret (docs/mobile/native-push-content.md). */
    private static let contentService = "com.polyth.mobile.native-push.content"
    private static let contentGroupSuffix = "com.polyth.mobile.push-content"
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
        case "completed", "failed", "question", "permission", "subagent", "mention", "message": return true
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
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: Self.contentService] as CFDictionary)
    }

    /** `<AppIdentifierPrefix>com.polyth.mobile.push-content`; nil when the
     * build did not substitute the prefix (then sealed content is simply off). */
    private func contentAccessGroup() -> String? {
        guard let prefix = Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String,
              !prefix.isEmpty, !prefix.contains("$(") else { return nil }
        return prefix + Self.contentGroupSuffix
    }

    private func contentRemove(_ subscriptionId: String) {
        // No access group: the delete covers every group this app can reach.
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: Self.contentService, kSecAttrAccount: subscriptionId] as CFDictionary)
    }

    private func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /** Creates (replacing any earlier item) the device content key for one
     * subscription and returns its public half, or nil when sealed content is
     * unavailable on this build; the notification then keeps its generic text. */
    private func makeContentKey(subscriptionId: String) -> [String: String]? {
        guard let group = contentAccessGroup() else { return nil }
        var auth = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, auth.count, &auth) == errSecSuccess else { return nil }
        let privateKey = P256.KeyAgreement.PrivateKey()
        var value = privateKey.rawRepresentation
        value.append(contentsOf: auth)
        let base: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: Self.contentService,
            kSecAttrAccount: subscriptionId,
            kSecAttrAccessGroup: group,
        ]
        SecItemDelete(base as CFDictionary)
        var item = base
        item[kSecValueData] = value
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { return nil }
        return ["p256dh": base64URL(privateKey.publicKey.x963Representation), "auth": base64URL(Data(auth))]
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
        contentRemove(mapping.subscriptionId)
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
            if let data = try? self.secureGet(Self.pendingKey),
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
            guard let data = try? self.secureGet(Self.pendingKey),
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
                    let contentKey = self.makeContentKey(subscriptionId: subscription)
                    try self.store(PushMapping(connectionId: input.connectionId, hostEndpointId: input.hostEndpointId, deviceEndpointId: input.deviceEndpointId, accountId: input.accountId, subscriptionId: subscription, manageToken: manage, binding: binding))
                    // Explicit re-enable replaces this connection/account's
                    // prior destination instead of retaining stale senders.
                    for item in previous where item.subscriptionId != subscription {
                        self.request("DELETE", path: "/v1/registrations/\(item.subscriptionId)", body: nil, manageToken: item.manageToken) { _ in }
                        self.forget(item)
                    }
                    var result: [String: Any] = ["subscriptionId": subscription, "claimToken": claim, "claimExpiresAt": expires]
                    if let contentKey { result["contentKey"] = contentKey }
                    call.resolve(result)
                } catch {
                    // Best-effort rollback prevents an unmanageable live
                    // destination after local Keychain persistence fails.
                    self.contentRemove(subscription)
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
